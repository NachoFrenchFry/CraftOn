// MockSupabase.js — an in-memory stand-in for supabase-js with exactly the calls the game uses, enabled
// with `?mockcloud`. State persists in localStorage (crafton.mockcloud.v1) so a page reload keeps the
// session and the worlds, like the real client, and every query re-reads the shared tables first, so two tabs
// of the same browser see each other's rows (the headless host / guest and kick tests). Row Level Security is
// imitated per table: worlds, chunks and active_sessions are owner-only; lobbies are owner-only except through
// the list_lobbies / find_lobbies / find_lobby_by_code RPCs; signals are visible to their sender and recipient and can only
// be inserted toward or from a lobby's host. The Edge Function `turn-credentials` is imitated by
// `functions.invoke`, which answers with fake TURN servers on a reserved `.invalid` host (nothing is contacted). The
// headless tests use only this; they never reach the real project. The `worlds` table copies the rules of
// world_lock_and_survival_badge.sql (Nov 11 2026): an inserted world has the Pure Survival badge only when it starts in
// Survival, `mode_locked` never changes after the insert, a locked world keeps its `game_mode`, and `survival_only` can only
// go from true to false (and goes false by itself when the mode leaves Survival); rows from before the update get the
// migration's one-time `survival_only = (game_mode = 'survival')`. friends.sql (Nov 12 2026): the `friendships` and
// `presence` tables are never readable directly (no TABLE_INFO entry: a query gets "relation does not exist"); the seven
// functions — presence_beat, presence_clear, search_users, send_friend_request, respond_friend_request, remove_friend,
// list_friends — answer like the SQL (one row per pair, relations seen from the caller, a second request accepts, presence
// older than 75 s is offline, a lobby only when fresh and public or on the caller's network, nothing about a non-friend but
// the name and the request).

const STORAGE_KEY = 'crafton.mockcloud.v1';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const now = () => new Date().toISOString();

const TABLES = ['users', 'profiles', 'worlds', 'chunks', 'sessions', 'lobbies', 'signals', 'friendships', 'presence'];
function emptyState() { return { users: [], profiles: [], session: null, worlds: [], chunks: [], sessions: [], lobbies: [], signals: [], friendships: [], presence: [] }; }
const PRESENCE_FRESH_MS = 75000;
const FRIEND_LIMIT = 200;
const PRESENCE_STATUSES = ['menu', 'playing', 'hosting', 'joined'];
function loadState() {
  let st = emptyState();
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) st = { ...st, ...JSON.parse(raw) }; } catch (e) { /* ignore */ }
  for (const t of TABLES) if (!Array.isArray(st[t])) st[t] = [];
  for (const w of st.worlds) { // the SQL migration: old rows get the two columns (Survival worlds keep the badge, their history being unknown)
    if (w.mode_locked === undefined) w.mode_locked = false;
    if (w.survival_only === undefined) w.survival_only = w.game_mode === 'survival';
  }
  return st;
}

/** The worlds_guard_flags trigger on UPDATE: the lock never changes, a locked world keeps its mode, the badge can only be lost. */
function guardWorldFlags(old, row, patch) {
  row.mode_locked = old.mode_locked === true;
  if (old.mode_locked === true) row.game_mode = old.game_mode;
  const sent = patch && Object.prototype.hasOwnProperty.call(patch, 'survival_only') ? patch.survival_only === true : old.survival_only === true; // coalesce(new.survival_only, false)
  row.survival_only = old.survival_only === true && sent && row.game_mode === 'survival';
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
          row.game_mode = row.game_mode || 'survival';
          row.mode_locked = row.mode_locked === true;             // the lock is chosen now and never again
          row.survival_only = row.game_mode === 'survival';     // the trigger decides the badge on INSERT, whatever the client sent
        }
        if (this.table === 'world_chunks' && !state.worlds.some((w) => w.id === row.world_id && w.user_id === uid)) return { data: null, error: { message: 'new row violates row-level security policy', status: 403 } };
        if (this.table === 'lobbies') {
          row.host_id = uid; row.id = row.id || uuid(); row.created_at = row.created_at || now();
          if (!row.world_name || row.world_name.length > 32) return { data: null, error: { message: 'world_name length', status: 400 } };
          if (row.network_hash != null && (row.network_hash.length < 16 || row.network_hash.length > 128)) return { data: null, error: { message: 'network_hash length', status: 400 } };
          if (row.network_hash === undefined) row.network_hash = null;
          row.visibility = row.visibility ?? 'public';
          if (!['public', 'private'].includes(row.visibility)) return { data: null, error: { message: 'new row for relation "lobbies" violates check constraint "lobbies_visibility_check"', status: 400 } };
          if (!JOIN_CODE.test(row.join_code || '')) return { data: null, error: { message: 'join_code format', status: 400 } };
          if (state.lobbies.some((l) => l.join_code === row.join_code && l.host_id !== uid)) return { data: null, error: { message: 'duplicate key value violates unique constraint "lobbies_join_code_key"', status: 409 } };
          row.player_count = row.player_count ?? 1; row.max_players = row.max_players ?? 8;
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
      for (const r of tableRows) if (matches(r)) { const old = { ...r }; Object.assign(r, this.patch, { updated_at: now() }); if (this.table === 'worlds') guardWorldFlags(old, r, this.patch); out.push(r); }
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
    /** Tests: every Edge Function call; `turnFails` makes turn-credentials answer 404 (not deployed) and `turnEmpty` { iceServers: [] } (no provider). */
    this.functionCalls = [];
    this.turnFails = false;
    this.turnEmpty = false;
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
      return { id: l.id, host_id: l.host_id, host_name: prof ? prof.username : 'host', world_name: l.world_name, player_count: l.player_count, max_players: l.max_players };
    };
    const fresh = (l) => Date.now() - Date.parse(l.updated_at) < LOBBY_FRESH_MS;
    if (name === 'list_lobbies') {
      // public_servers.sql: every fresh public lobby plus the private ones on the caller's network, same network first.
      const hash = args.p_network_hash || null;
      const same = (l) => !!hash && l.network_hash === hash;
      const rows = this.state.lobbies.filter((l) => fresh(l) && ((l.visibility || 'public') === 'public' || same(l)))
        .sort((a, b) => (same(b) - same(a)) || (Date.parse(b.updated_at) - Date.parse(a.updated_at)))
        .map((l) => ({ ...lobbyRow(l), same_network: same(l) }));
      return { data: rows, error: null };
    }
    if (name === 'find_lobbies') return { data: this.state.lobbies.filter((l) => l.network_hash != null && l.network_hash === args.p_network_hash && fresh(l)).map(lobbyRow), error: null };
    if (name === 'find_lobby_by_code') return { data: this.state.lobbies.filter((l) => l.join_code === String(args.p_code || '').toUpperCase() && fresh(l)).map(lobbyRow), error: null };
    // ---- friends.sql ----
    const me = this.state.session ? this.state.session.user.id : null;
    const notSignedIn = () => ({ data: null, error: { message: 'not signed in', status: 401 } });
    const pair = (x, y) => (x < y ? [x, y] : [y, x]); // user_a is the smaller id (uuid text order = the byte order Postgres uses)
    const pairRow = (x, y) => { const [a, b] = pair(x, y); return this.state.friendships.find((f) => f.user_a === a && f.user_b === b) || null; };
    const waitingFor = (uid) => this.state.friendships.filter((f) => f.status === 'pending' && (f.user_a === uid || f.user_b === uid) && f.requested_by !== uid).length;
    const relationOf = (f) => (!f ? 'none' : f.status === 'accepted' ? 'friends' : f.requested_by === me ? 'sent' : 'received');
    const profile = (id) => this.state.profiles.find((p) => p.id === id) || null;
    if (name === 'presence_beat') {
      if (!me) return notSignedIn();
      const status = String(args.p_status || '');
      if (!PRESENCE_STATUSES.includes(status)) return { data: null, error: { message: 'new row for relation "presence" violates check constraint "presence_status_check"', status: 400 } };
      const row = { user_id: me, status, world_name: args.p_world_name == null ? null : String(args.p_world_name).slice(0, 32), lobby_id: args.p_lobby_id || null, updated_at: now() };
      const i = this.state.presence.findIndex((x) => x.user_id === me);
      if (i >= 0) this.state.presence[i] = row; else this.state.presence.push(row);
      this.persist();
      return { data: waitingFor(me), error: null };
    }
    if (name === 'presence_clear') {
      if (!me) return notSignedIn();
      this.state.presence = this.state.presence.filter((x) => x.user_id !== me);
      this.persist();
      return { data: null, error: null };
    }
    if (name === 'search_users') {
      if (!me) return notSignedIn();
      const q = String(args.p_query || '');
      if (!/^[A-Za-z0-9_]{2,16}$/.test(q)) return { data: [], error: null };
      const lq = q.toLowerCase();
      const rows = this.state.profiles.filter((p) => p.id !== me && p.username.toLowerCase().startsWith(lq))
        .sort((x, y) => (Number(y.username.toLowerCase() === lq) - Number(x.username.toLowerCase() === lq)) || (x.username.length - y.username.length) || (x.username < y.username ? -1 : x.username > y.username ? 1 : 0))
        .slice(0, 10)
        .map((p) => ({ id: p.id, username: p.username, relation: relationOf(pairRow(me, p.id)) }));
      return { data: rows, error: null };
    }
    if (name === 'send_friend_request') {
      if (!me) return notSignedIn();
      const them = this.state.profiles.find((p) => p.username.toLowerCase() === String(args.p_username || '').toLowerCase()) || null;
      if (!them) return { data: 'not_found', error: null };
      if (them.id === me) return { data: 'self', error: null };
      const f = pairRow(me, them.id);
      if (f) {
        if (f.status === 'accepted') return { data: 'already_friends', error: null };
        if (f.requested_by === me) return { data: 'already_sent', error: null };
        f.status = 'accepted'; f.updated_at = now(); this.persist(); // they had already asked me
        return { data: 'accepted', error: null };
      }
      if (this.state.friendships.filter((x) => x.user_a === me || x.user_b === me).length >= FRIEND_LIMIT) return { data: 'limit', error: null };
      const [a, b] = pair(me, them.id);
      this.state.friendships.push({ user_a: a, user_b: b, requested_by: me, status: 'pending', created_at: now(), updated_at: now() });
      this.persist();
      return { data: 'sent', error: null };
    }
    if (name === 'respond_friend_request') {
      if (!me) return notSignedIn();
      const other = String(args.p_user || '');
      const f = pairRow(me, other);
      const ok = !!(f && f.status === 'pending' && f.requested_by === other);
      if (ok) { if (args.p_accept) { f.status = 'accepted'; f.updated_at = now(); } else this.state.friendships = this.state.friendships.filter((x) => x !== f); this.persist(); }
      return { data: ok, error: null };
    }
    if (name === 'remove_friend') {
      if (!me) return notSignedIn();
      const f = pairRow(me, String(args.p_user || ''));
      if (f) { this.state.friendships = this.state.friendships.filter((x) => x !== f); this.persist(); }
      return { data: !!f, error: null };
    }
    if (name === 'list_friends') {
      if (!me) return notSignedIn();
      const hash = args.p_network_hash || null;
      const rows = [];
      for (const f of this.state.friendships) {
        if (f.user_a !== me && f.user_b !== me) continue;
        const otherId = f.user_a === me ? f.user_b : f.user_a;
        const p = profile(otherId);
        if (!p) continue;
        const accepted = f.status === 'accepted';
        const pr = this.state.presence.find((x) => x.user_id === otherId && Date.now() - Date.parse(x.updated_at) < PRESENCE_FRESH_MS) || null;
        let l = null;
        if (accepted && pr && pr.lobby_id) { const cand = this.state.lobbies.find((x) => x.id === pr.lobby_id); if (cand && fresh(cand) && ((cand.visibility || 'public') === 'public' || (hash && cand.network_hash === hash))) l = cand; }
        const hp = l ? profile(l.host_id) : null;
        rows.push({
          id: p.id, username: p.username, relation: accepted ? 'friends' : f.requested_by === me ? 'sent' : 'received',
          online: accepted && !!pr, status: accepted && pr ? pr.status : null, world_name: accepted && pr ? pr.world_name : null,
          lobby_id: l ? l.id : null, lobby_host_id: l ? l.host_id : null, lobby_host_name: hp ? hp.username : null, lobby_world_name: l ? l.world_name : null,
          player_count: l ? l.player_count : null, max_players: l ? l.max_players : null, same_network: !!(l && hash && l.network_hash === hash),
          _pending: !accepted, _present: !!pr,
        });
      }
      rows.sort((x, y) => (Number(y._pending) - Number(x._pending)) || (Number(y._present) - Number(x._present)) || (x.username.toLowerCase() < y.username.toLowerCase() ? -1 : x.username.toLowerCase() > y.username.toLowerCase() ? 1 : 0));
      for (const r of rows) { delete r._pending; delete r._present; }
      return { data: rows.slice(0, 250), error: null };
    }
    return { data: null, error: { message: `function ${name} does not exist`, status: 404 } };
  }

  /** Edge Functions: `turn-credentials` answers like the real one, with servers on a reserved host. */
  get functions() {
    const mock = this;
    return {
      async invoke(name, opts = {}) {
        if (mock.offline) return { data: null, error: { message: 'Failed to send a request to the Edge Function', name: 'FunctionsFetchError' } };
        mock.functionCalls.push({ name, at: Date.now(), method: (opts && opts.method) || 'POST' });
        if (!mock.state.session) return { data: null, error: { message: 'Invalid JWT', name: 'FunctionsHttpError', status: 401 } };
        if (name !== 'turn-credentials') return { data: null, error: { message: `Function ${name} not found`, name: 'FunctionsHttpError', status: 404 } };
        if (mock.turnFails) return { data: null, error: { message: 'Requested function was not found', name: 'FunctionsHttpError', context: { status: 404 } } };
        const ttl = 7200;
        if (mock.turnEmpty) return { data: { iceServers: [], ttl, provider: null }, error: null };
        return {
          data: {
            iceServers: [
              { urls: ['stun:stun.mockcloud.invalid:3478'] },
              { urls: ['turn:turn.mockcloud.invalid:3478?transport=udp', 'turn:turn.mockcloud.invalid:3478?transport=tcp', 'turns:turn.mockcloud.invalid:5349?transport=tcp'], username: 'mock-' + Math.floor(Date.now() / 1000 + ttl), credential: 'mock-credential' },
            ],
            ttl,
            provider: 'mock',
          },
          error: null,
        };
      },
    };
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
