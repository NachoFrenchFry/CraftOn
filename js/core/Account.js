// Account.js — username + password accounts on top of Supabase Auth (Update #6). Usernames map to a hidden
// placeholder email (see SupabaseConfig.js); the player never sees it. Errors are turned into friendly
// messages. The session is kept by supabase-js (or the mock), so reloads stay logged in.

import { PSEUDO_EMAIL_DOMAIN, USERNAME_PATTERN, PASSWORD_MIN_LENGTH } from '../config/SupabaseConfig.js';
import { isNetworkError } from './cloud/CloudClient.js';

export const AccountError = Object.freeze({
  INVALID_USERNAME: 'Usernames are 3–16 letters, digits or underscores.',
  PASSWORD_SHORT: `Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`,
  PASSWORD_MISMATCH: 'The passwords do not match.',
  USERNAME_TAKEN: 'Username taken.',
  WRONG_CREDENTIALS: 'Wrong username or password.',
  RATE_LIMITED: 'Too many attempts, try again later.',
  OFFLINE: "Can't reach the server, check your connection.",
  UNKNOWN: 'Something went wrong. Please try again.',
});

export const pseudoEmail = (username) => `${username.toLowerCase()}@${PSEUDO_EMAIL_DOMAIN}`;

function friendly(error) {
  if (!error) return AccountError.UNKNOWN;
  if (isNetworkError(error)) return AccountError.OFFLINE;
  const msg = String(error.message || error);
  const status = error.status || error.code;
  if (status === 429 || /rate limit|too many/i.test(msg)) return AccountError.RATE_LIMITED;
  if (/Invalid login credentials|invalid_credentials/i.test(msg)) return AccountError.WRONG_CREDENTIALS;
  if (/already registered|already exists|duplicate|taken/i.test(msg)) return AccountError.USERNAME_TAKEN;
  if (/Password should be|password.*short|at least/i.test(msg)) return AccountError.PASSWORD_SHORT;
  if (/email.*invalid|invalid.*email/i.test(msg)) return 'The account name is not accepted by the server.';
  return AccountError.UNKNOWN;
}

export class Account {
  /**
   * @param {object} client supabase-js client or MockSupabase
   * @param {import('./EventBus.js').EventBus} events emits 'account:changed' (username | null)
   */
  constructor(client, events) {
    this.client = client;
    this.events = events;
    this.session = null;
    this.username = null;
    client.auth.onAuthStateChange((event, session) => {
      const was = this.username;
      this._apply(session);
      if (event === 'SIGNED_OUT' || (was && !this.username)) this.events.emit('account:signedout');
      this.events.emit('account:changed', this.username);
    });
  }

  get loggedIn() { return !!this.session; }

  _apply(session) {
    this.session = session || null;
    this.username = session && session.user ? (session.user.user_metadata && session.user.user_metadata.username) || null : null;
  }

  /** Restore a persisted session at startup. @returns {Promise<boolean>} logged in */
  async restore() {
    try {
      const { data } = await this.client.auth.getSession();
      const s = data && data.session;
      if (s && s.expires_at && s.expires_at * 1000 < Date.now() - 60000) { await this.client.auth.signOut(); this._apply(null); return false; }
      this._apply(s);
      if (this.session && !this.username) this.username = await this._fetchUsername();
      return this.loggedIn;
    } catch (e) { this._apply(null); return false; }
  }

  async _fetchUsername() {
    try {
      const { data } = await this.client.from('profiles').select('username').eq('id', this.session.user.id).single();
      return data ? data.username : null;
    } catch (e) { return null; }
  }

  /** @returns {Promise<{ok: boolean, error?: string}>} */
  async signUp(username, password, confirm) {
    username = String(username || '').trim();
    if (!USERNAME_PATTERN.test(username)) return { ok: false, error: AccountError.INVALID_USERNAME };
    if (!password || password.length < PASSWORD_MIN_LENGTH) return { ok: false, error: AccountError.PASSWORD_SHORT };
    if (password !== confirm) return { ok: false, error: AccountError.PASSWORD_MISMATCH };
    try {
      const avail = await this.client.rpc('username_available', { name: username });
      if (avail.error) return { ok: false, error: friendly(avail.error) };
      if (avail.data === false) return { ok: false, error: AccountError.USERNAME_TAKEN };
      const { data, error } = await this.client.auth.signUp({ email: pseudoEmail(username), password, options: { data: { username } } });
      if (error) return { ok: false, error: friendly(error) };
      if (!data || !data.session) {
        // Confirmation is off, so a session is expected; fall back to a normal login just in case.
        const login = await this.client.auth.signInWithPassword({ email: pseudoEmail(username), password });
        if (login.error) return { ok: false, error: friendly(login.error) };
        this._apply(login.data.session);
      } else this._apply(data.session);
      this.username = username;
      this.events.emit('account:changed', this.username);
      return { ok: true };
    } catch (e) { return { ok: false, error: friendly(e) }; }
  }

  async signIn(username, password) {
    username = String(username || '').trim();
    if (!USERNAME_PATTERN.test(username) || !password) return { ok: false, error: AccountError.WRONG_CREDENTIALS };
    try {
      const { data, error } = await this.client.auth.signInWithPassword({ email: pseudoEmail(username), password });
      if (error) return { ok: false, error: friendly(error) };
      this._apply(data.session);
      if (!this.username) this.username = username;
      this.events.emit('account:changed', this.username);
      return { ok: true };
    } catch (e) { return { ok: false, error: friendly(e) }; }
  }

  async signOut() {
    try { await this.client.auth.signOut(); } catch (e) { /* offline: drop the local session anyway */ }
    this._apply(null);
    this.events.emit('account:changed', null);
  }
}
