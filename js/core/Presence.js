// Presence.js — "this is what I'm doing" for my friends (part 4 of 4, Nov 12 2026): the presence_beat function of friends.sql,
// called every 30 s while logged in and at once whenever the status changes — menu (any menu), playing (a world open to
// nobody: the world's name), hosting (hosting, or Same Wi-Fi multiplayer on: the name and my lobby's id), joined (someone
// else's server: that world's name and lobby id). The answer is the number of friend requests waiting for me, emitted as
// 'friends:waiting' (the Requests section of the home screen's Friends sidebar, and "Friends (2)" on its collapsed button).
// presence_clear on log out and on pagehide (best effort; a closed tab
// looks offline after 75 s anyway). Stopped while kicked by the session guard. Failures are silent: the next tick retries.
// Plain requests on a timer, never Supabase Realtime.
import { State } from './GameState.js';

export const PRESENCE_INTERVAL_MS = 30000;

export class Presence {
  /** @param {import('./Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.timer = null;
    this.running = false;
    /** The last status sent, as a key, so a change beats at once. */
    this.last = null;
    /** Friend requests waiting for me, from the last answer. */
    this.waiting = 0;
    this.inflight = false;
    this.again = false;
    this.beats = 0;
    game.events.on('state:changed', () => this.refresh());
    game.events.on('net:changed', () => this.refresh());
    game.events.on('account:changed', (username) => { if (username) this.start(); else this.stop(); });
    window.addEventListener('pagehide', () => { if (this.running) this.clear(); });
  }

  /** What I am doing: { status, worldName, lobbyId }, or null when nothing should be sent (not logged in, kicked). */
  status() {
    const g = this.game;
    if (!g.account || !g.account.loggedIn || g.kicked || g.state.is(State.ACCOUNT) || g.state.is(State.KICKED) || g.state.is(State.BOOT)) return null;
    const net = g.net, meta = g.worldMeta;
    if (g.state.inWorld && meta) {
      const worldName = String(meta.name || '').slice(0, 32);
      if (net && net.isHost) return { status: 'hosting', worldName, lobbyId: net.lobby ? net.lobby.id : null };
      if (net) return { status: 'joined', worldName, lobbyId: net.lobby ? net.lobby.id : null };
      return { status: 'playing', worldName, lobbyId: null };
    }
    return { status: 'menu', worldName: null, lobbyId: null };
  }

  /** Begin the heartbeat (logged in): one beat now, then every 30 s. */
  start() {
    if (this.running) return;
    this.running = true;
    this.last = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.beat(), PRESENCE_INTERVAL_MS);
    this.beat();
  }

  /** Stop the heartbeat (logged out, kicked). */
  stop() {
    this.running = false;
    this.last = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** The status may have changed (a state or network change): beat at once when it did. */
  refresh() {
    if (!this.running) return;
    const s = this.status();
    const key = s ? `${s.status}|${s.worldName}|${s.lobbyId}` : null;
    if (key !== this.last) this.beat();
  }

  /** One presence_beat; the answer updates the waiting count. Never throws, never shows anything. */
  async beat() {
    const g = this.game;
    if (!this.running || !g.cloud) return false;
    const s = this.status();
    if (!s) return false;
    if (this.inflight) { this.again = true; return false; }
    this.inflight = true;
    const key = `${s.status}|${s.worldName}|${s.lobbyId}`;
    try {
      const res = await g.cloud.rpc('presence_beat', { p_status: s.status, p_world_name: s.worldName, p_lobby_id: s.lobbyId });
      if (!res || res.error) return false;
      this.last = key;
      this.beats++;
      this.setWaiting(Number(res.data) || 0);
      return true;
    } catch (e) { return false; } // offline: the next tick retries
    finally { this.inflight = false; if (this.again) { this.again = false; this.refresh(); } }
  }

  /** The number of requests waiting for me (also fed by the Friends sidebar's list). */
  setWaiting(n) {
    n = Math.max(0, n | 0);
    if (n === this.waiting) return;
    this.waiting = n;
    this.game.events.emit('friends:waiting', n);
  }

  /** Going offline (log out, pagehide): stop and tell the server, best effort. */
  async clear() {
    this.stop();
    const g = this.game;
    if (!g.cloud || !g.account || !g.account.loggedIn) return;
    try { await Promise.race([g.cloud.rpc('presence_clear', {}), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* best effort */ }
  }
}
