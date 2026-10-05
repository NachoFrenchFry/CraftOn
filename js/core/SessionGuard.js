// SessionGuard.js — one place per account (Update #8). Each page load is an "instance" with a random id. On
// login and when entering a world the instance claims the account by upserting its id into active_sessions
// (plain REST) and announces it on a BroadcastChannel so other tabs of the same browser are kicked at once; a
// heartbeat every HEARTBEAT_SECONDS reads the row back and, if another instance owns it now, this one has been
// kicked. The newest claim always wins. Game.onKicked() handles the consequences (stop, last save, screen).

const HEARTBEAT_SECONDS = 10;
const CHANNEL = 'crafton.session.v1';

const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export class SessionGuard {
  /**
   * @param {object} client supabase-js or MockSupabase
   * @param {import('./Account.js').Account} account
   * @param {(reason: string) => void} onKicked
   */
  constructor(client, account, onKicked) {
    this.client = client;
    this.account = account;
    this.onKicked = onKicked;
    this.instanceId = randomId();
    this.claimedUser = null;
    this.kicked = false;
    this.timer = null;
    this.channel = null;
    /** Optional logger (Game points it at console.log with ?debuglog). */
    this.log = null;
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e) => this._onAnnounce(e.data);
    } catch (e) { this.channel = null; }
  }

  get active() { return !!this.claimedUser && !this.kicked; }

  /** Claim the account for this instance (kicking every other place). Resolves false when the server refused. */
  async claim() {
    const userId = this.account.session && this.account.session.user ? this.account.session.user.id : null;
    if (!userId) return false;
    this.kicked = false;
    this.claimedUser = userId;
    try {
      const res = await this.client.from('active_sessions').upsert({ user_id: userId, instance_id: this.instanceId }, { onConflict: 'user_id' });
      if (res && res.error) throw new Error(res.error.message);
    } catch (e) {
      console.warn('SessionGuard: claim failed', e);
      return false;
    }
    if (this.channel) { try { this.channel.postMessage({ userId, instanceId: this.instanceId }); } catch (e) { /* ignore */ } }
    if (this.log) this.log(`session claimed by ${this.instanceId.slice(0, 8)} for user ${userId.slice(0, 8)}`);
    this._startHeartbeat();
    return true;
  }

  /** Stop watching (log out). The row is left for the next claim. */
  release() {
    this.claimedUser = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _startHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_SECONDS * 1000);
  }

  /** Read the row: another instance id means this one was kicked. Public so tests can trigger it. */
  async heartbeat() {
    if (!this.claimedUser || this.kicked) return true;
    try {
      const res = await this.client.from('active_sessions').select('instance_id').eq('user_id', this.claimedUser).single();
      if (res && res.error) return true; // can't tell (offline): keep going
      if (res && res.data && res.data.instance_id && res.data.instance_id !== this.instanceId) { this._kick('another device'); return false; }
    } catch (e) { /* offline: keep going */ }
    return true;
  }

  _onAnnounce(data) {
    if (this.log) this.log(`session announce from ${data && data.instanceId ? data.instanceId.slice(0, 8) : '?'} for user ${data && data.userId ? data.userId.slice(0, 8) : '?'} (mine: ${this.claimedUser ? this.claimedUser.slice(0, 8) : '-'})`);
    if (!data || !this.claimedUser || this.kicked) return;
    if (data.userId === this.claimedUser && data.instanceId !== this.instanceId) this._kick('another tab');
  }

  _kick(reason) {
    if (this.kicked) return;
    this.kicked = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.onKicked(reason);
  }
}
