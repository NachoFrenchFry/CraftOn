// MockSupabase.js — an in-memory stand-in for supabase-js with exactly the calls the game uses, enabled
// with `?mockcloud`. State persists in localStorage (crafton.mockcloud.v1) so a page reload keeps the
// session and the worlds, like the real client, and every query re-reads the shared tables first, so two tabs
// of the same browser see each other's rows (the headless host / guest and kick tests). Row Level Security is
// imitated per table: worlds, chunks and active_sessions are owner-only; lobbies are owner-only except through
// the find_lobbies / find_lobby_by_code RPCs; signals are visible to their sender and recipient and can only
// be inserted toward or from a lobby's host. The headless tests use only this; they never reach the real
// project.

const STORAGE_KEY = 'crafton.mockcloud.v1';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const now = () => new Date().toISOString();

const TABLES = ['users', 'profiles', 'worlds', 'chunks', 'sessions', 'lobbies', 'signals'];
function emptyState() { return { users: [], profiles: [], session: null, worlds: [], chunks: [], sessions: [], lobbies: [], signals: [] }; }
function loadState() {
  let st = emptyState();
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) st = { ...st, ...JSON.parse(raw) }; } catch (e) { /* ignore */ }
  for (const t of TABLES) if (!Array.isArray(st[t])) st[t] = [];
  return st;
}
/** table name → state key and the column that owns a row (RLS). */
const TABLE_INFO = {
  worlds: { key: 'worlds', owner: 'user_id' },
  world_chunks: { key: 'chunks', owner: 'user_id' },
  profiles: { key: 'profiles', owner: 'user_id' },
  active_sessions: { key: 'sessions', owner: 'user_id', conflict: 'user_id' },
  lobbies: { key: 'lobbies', owner: 'host_id', conflict: 'host_id' },
  signals: { key: 'signals', owner: null },
};
const JOIN_CODE = /^[A-Z0-9]{6}$/;
const LOBBY_FRESH_MS = 30000;

/** Thenable query builder: filters accumulate, the query runs when awaited. */
class Query {
  constructor(mock, table) {
    this.mock = mock; this.table = table; this.op = 'select'; this.columns = '*'; this.rows = null; this.patch = null;
    this.filters = []; this.orderBy = null; this.rangeFrom = 0; this.rangeTo = Infinity; this.wantSingle = false; this.onConflict = null;
  }
  select(cols = '*') { if (this.op === 'select') this.columns = cols; else this.returning = cols; return this; }
  insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.op = 'update'; this.patch = patch; return this; }
  upsert(rows, opts = {}) { this.op = 'upsert'; this.rows = Array.isArray(rows) ? rows : [rows]; this.onConflict = opts.onConflict || null; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, val) { this.filters.push([col, val]); return this; }
  order(col, opts = {}) { this.orderBy = { col, ascending: opts.ascending !== false }; return this; }
  range(from, to) { this.rangeFrom = from; this.rangeTo = to; return this; }
  single() { this.wantSingle = true; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this._run()).then(resolve, reject); }

  _project(row) {
    if (this.columns === '*') return { ...row };
    const out = {};
    for (const part of this.columns.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^(\w+)->>?(\w+)$/);
      if (m) out[m[2]] = row[m[1]] ? row[m[1]][m[2]] : null;
      else out[part] = row[part];
    }
    return out;
  }

  _run() {
    const mock = this.mock;
    mock._sync(); // other tabs may have written since
    const state = mock.state;
    const uid = state.session ? state.session.user.id : null;
    if (!uid) return { data: null, error: { message: 'JWT expired', status: 401 } };
    if (mock.offline) return Promise.reject(new TypeError('Failed to fetch'));
    const info = TABLE_INFO[this.table];
    const tableRows = info ? state[info.key] : null;
    if (!tableRows) return { data: null, error: { message: `relation "${this.table}" does not exist`, status: 404 } };
    const visible = (r) => info.owner ? r[info.owner] === uid : (r.from_user === uid || r.to_user === uid);
    const matches = (r) => visible(r) && this.filters.every(([c, v]) => r[c] === v);
    const isHostOf = (lobbyId, user) => state.lobbies.some((l) => l.id === lobbyId && l.host_id === user);
    let data = null;
    if (this.op === 'select') {
      let rows = tableRows.filter(matches);
      if (this.orderBy) rows.sort((a, b) => (a[this.orderBy.col] < b[this.orderBy.col] ? -1 : 1) * (this.orderBy.ascending ? 1 : -1));
      rows = rows.slice(this.rangeFrom, this.rangeTo === Infinity ? undefined : this.rangeTo + 1).map((r) => this._project(r));
      if (this.wantSingle) { if (rows.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }; data = rows[0]; } else data = rows;
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const out = [];
      for (const r of this.rows) {
        const row = { ...r, updated_at: now() };
        if (info.owner === 'user_id') row.user_id = uid;
        if (this.table === 'worlds') {
          if (!row.name || row.name.length > 32) return { data: null, error: { message: 'name length', status: 400 } };
          row.id = row.id || uuid(); row.created_at = row.created_at || now(); row.data = row.data || {};
        }
        if (this.table === 'world_chunks' && !state.worlds.some((w) => w.id === row.world_id && w.user_id === uid)) return { data: null, error: { message: 'new row violates row-level security policy', status: 403 } };
        if (this.table === 'lobbies') {
          row.host_id = uid; row.id = row.id || uuid(); row.created_at = row.created_at || now();
          if (!row.world_name || row.world_name.length > 32) return { data: null, error: { message: 'world_name length', status: 400 } };
          if (!row.network_hash || row.network_hash.length < 16 || row.network_hash.length > 128) return { data: null, error: { message: 'network_hash length', status: 400 } };
          if (!JOIN_CODE.test(row.join_code || '')) return { data: null, error: { message: 'join_code format', status: 400 } };
          if (state.lobbies.some((l) => l.join_code === row.join_code && l.host_id !== uid)) return { data: null, error: { message: 'duplicate key value violates unique constraint "lobbies_join_code_key"', status: 409 } };
          row.player_count = row.player_count ?? 1; row.max_players = row.max_players ?? 8; row.game_version = row.game_version ?? '';
        }
        if (this.table === 'signals') {
          row.id = row.id || uuid(); row.from_user = uid; row.created_at = row.created_at || now();
          if (!['offer', 'answer', 'reject'].includes(row.kind)) return { data: null, error: { message: 'kind check', status: 400 } };
          if (!(isHostOf(row.lobby_id, uid) || isHostOf(row.lobby_id, row.to_user))) return { data: null, error: { message: 'new row violates row-level security policy', status: 403 } };
        }
        if (this.table === 'active_sessions') { row.user_id = uid; if (!row.instance_id) return { data: null, error: { message: 'instance_id required', status: 400 } }; }
        let existing = -1;
        if (this.op === 'upsert') {
          const keys = (this.onConflict || info.conflict || 'id').split(',').map((s) => s.trim());
          existing = tableRows.findIndex((t) => keys.every((k) => t[k] === row[k]));
        } else if (this.table === 'lobbies' && tableRows.some((t) => t.host_id === uid)) return { data: null, error: { message: 'duplicate key value violates unique constraint "lobbies_host_id_key"', status: 409 } };
        if (existing >= 0) { tableRows[existing] = { ...tableRows[existing], ...row }; out.push(tableRows[existing]); } else { tableRows.push(row); out.push(row); }
      }
      data = this.returning ? out.map((r) => this._projectWith(this.returning, r)) : null;
      if (this.wantSingle && data) data = data[0];
    } else if (this.op === 'update') {
      const out = [];
      for (const r of tableRows) if (matches(r)) { Object.assign(r, this.patch, { updated_at: now() }); out.push(r); }
      data = this.returning ? out.map((r) => this._projectWith(this.returning, r)) : null;
    } else if (this.op === 'delete') {
      const keep = tableRows.filter((r) => !matches(r));
      const removed = tableRows.filter(matches);
      tableRows.length = 0; tableRows.push(...keep);
      if (this.table === 'worlds') { const ids = new Set(removed.map((r) => r.id)); state.chunks = state.chunks.filter((c) => !ids.has(c.world_id)); }
      if (this.table === 'lobbies') { const ids = new Set(removed.map((r) => r.id)); state.signals = state.signals.filter((c) => !ids.has(c.lobby_id)); }
      data = null;
    }
    mock.persist();
    return { data, error: null };
  }
  _projectWith(cols, row) { const q = new Query(this.mock, this.table); q.columns = cols; return q._project(row); }
}

export class MockSupabase {
  constructor() {
    this.state = loadState();
    this.listeners = new Set();
    this.offline = false;          // tests can flip this to simulate "can't reach the server"
    this.failNextWrites = 0;       // tests can make the next N writes fail (save retry path)
    this.isMock = true;
    this.auth = {
      signUp: async ({ email, password, options }) => {
        if (this.offline) throw new TypeError('Failed to fetch');
        this._sync();
        const username = options && options.data && options.data.username;
        if (this.state.users.some((u) => u.email === email || u.username.toLowerCase() === String(username).toLowerCase())) return { data: { user: null, session: null }, error: { message: 'User already registered', status: 422 } };
        if (!password || password.length < 6) return { data: { user: null, session: null }, error: { message: 'Password should be at least 6 characters', status: 422 } };
        const user = { id: uuid(), email, user_metadata: { username } };
        this.state.users.push({ ...user, password, username });
        this.state.profiles = this.state.profiles || [];
        this.state.profiles.push({ id: user.id, user_id: user.id, username, created_at: now() });
        return this._login(user);
      },
      signInWithPassword: async ({ email, password }) => {
        if (this.offline) throw new TypeError('Failed to fetch');
        this._sync();
        const u = this.state.users.find((x) => x.email === email && x.password === password);
        if (!u) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials', status: 400 } };
        return this._login({ id: u.id, email: u.email, user_metadata: u.user_metadata });
      },
      signOut: async () => { this.state.session = null; this.persist(); this._emit('SIGNED_OUT', null); return { error: null }; },
      getSession: async () => ({ data: { session: this.state.session }, error: null }),
      onAuthStateChange: (cb) => { this.listeners.add(cb); return { data: { subscription: { unsubscribe: () => this.listeners.delete(cb) } } }; },
    };
  }

  _login(user) {
    const session = { access_token: 'mock-' + user.id, user, expires_at: Math.floor(Date.now() / 1000) + 3600 };
    this.state.session = session; this.persist();
    this._emit('SIGNED_IN', session);
    return { data: { user, session }, error: null };
  }
  _emit(event, session) { for (const cb of this.listeners) { try { cb(event, session); } catch (e) { console.error(e); } } }

  async rpc(name, args = {}) {
    if (this.offline) throw new TypeError('Failed to fetch');
    this._sync();
    if (name === 'username_available') return { data: !this.state.users.some((u) => u.username.toLowerCase() === String(args.name).toLowerCase()), error: null };
    const lobbyRow = (l) => {
      const prof = this.state.profiles.find((p) => p.id === l.host_id);
      return { id: l.id, host_id: l.host_id, host_name: prof ? prof.username : 'host', world_name: l.world_name, player_count: l.player_count, max_players: l.max_players, game_version: l.game_version };
    };
    const fresh = (l) => Date.now() - Date.parse(l.updated_at) < LOBBY_FRESH_MS;
    if (name === 'find_lobbies') return { data: this.state.lobbies.filter((l) => l.network_hash === args.p_network_hash && fresh(l)).map(lobbyRow), error: null };
    if (name === 'find_lobby_by_code') return { data: this.state.lobbies.filter((l) => l.join_code === String(args.p_code || '').toUpperCase() && fresh(l)).map(lobbyRow), error: null };
    return { data: null, error: { message: `function ${name} does not exist`, status: 404 } };
  }

  /** Re-read the shared tables another tab may have changed (this tab keeps its own session). */
  _sync() {
    const fresh = loadState();
    for (const t of TABLES) this.state[t] = fresh[t];
  }

  from(table) {
    const q = new Query(this, table);
    if (this.failNextWrites > 0) {
      const run = q._run.bind(q);
      q._run = () => { if (q.op !== 'select' && this.failNextWrites > 0) { this.failNextWrites--; return { data: null, error: { message: 'mock: simulated write failure', status: 503 } }; } return run(); };
    }
    return q;
  }

  persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (e) { /* quota */ } }
  /** Tests: wipe every account, world, lobby and session. */
  reset() { this.state = emptyState(); this.persist(); }
}
