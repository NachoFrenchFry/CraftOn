// FriendsSidebar.js — the Friends sidebar on the home screen (Nov 14 2026; until then a separate Friends screen, part 4 of 4):
// docked to the right edge of #main-menu so who is online shows without opening anything. Top to bottom: "Friends · 2 online",
// the Requests section (only when there are any: to me → Accept / Decline, mine → "Waiting…" / Cancel), the friends list
// (online first, then offline, each by name; a green / gray dot, the name, the status line "Offline" / "In the menus" /
// "Playing X" / "Hosting X" / "Playing on a server: X"; Join only when list_friends returned a lobby — public, or on my Wi-Fi
// with the Same Wi-Fi badge — disabled "Full" when full, joining exactly like the server list; a small × that turns into
// "Remove?" for 3 s), a one-line note (the send_friend_request answer or the connection error), and the search bar pinned at
// the bottom with its results opening upward above it (search_users after a 300 ms pause, 2+ characters, up to 10 names, one
// button per relation: Add / Requested / Accept / "Friends"). list_friends runs when the home screen appears and every 5 s
// while it is visible (never while the browser tab is hidden), at once after every button; an error keeps the last list.
// In a window too narrow for the menu and the sidebar side by side the sidebar collapses to a "Friends" / "Friends (2)"
// button in the top-right corner that opens it over the menu (the button again or Esc closes it). Plain requests only,
// never Realtime.
import { detectNetworkHash } from '../net/NetworkId.js';

const REFRESH_MS = 5000;
const SEARCH_DEBOUNCE_MS = 300;
const REMOVE_CONFIRM_MS = 3000;
/** Collapsed under this many gui-pixels of window width (the menu's 300 plus a sidebar no longer fit side by side)… */
export const COLLAPSE_BELOW_GUI = 340;
/** …or under this many CSS pixels whatever the scale (a phone in portrait: 390 wide is GUI scale 1, and 390 − 120 is no home screen). */
export const COLLAPSE_BELOW_PX = 600;
export const FRIENDS_ERROR_TEXT = "Couldn't reach the server. Check your connection.";
export const NO_FRIENDS_TEXT = 'No friends yet. Search a username below to add someone.';

/** The sentence for a send_friend_request answer. */
export function sendResultText(result, name) {
  switch (result) {
    case 'sent': return `Request sent to ${name}`;
    case 'accepted': return `You're now friends with ${name}`;
    case 'already_friends': return "You're already friends.";
    case 'already_sent': return 'You already sent a request.';
    case 'not_found': return 'No player with that name.';
    case 'self': return "That's you.";
    case 'limit': return 'You have reached the limit of 200 friends and requests.';
    default: return FRIENDS_ERROR_TEXT;
  }
}

/** The status line of a friend row (`world` is wrapped in its own span by the caller). */
export function statusParts(r) {
  if (!r.online) return ['Offline', null];
  if (r.status === 'menu') return ['In the menus', null];
  if (r.status === 'playing') return ['Playing ', r.world_name || ''];
  if (r.status === 'hosting') return ['Hosting ', r.world_name || ''];
  if (r.status === 'joined') return ['Playing on a server: ', r.world_name || ''];
  return ['Online', null];
}

export class FriendsSidebar {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    const $ = (id) => document.getElementById(id);
    /** The home screen the sidebar is part of (its classes: friends-collapsed, friends-open). */
    this.menu = $('main-menu');
    this.root = $('friends-side');
    this.toggle = $('btn-friends-toggle');
    this.online = $('friends-online');
    this.requests = $('friends-requests');
    this.list = $('friends-list');
    this.note = $('friends-note');
    this.results = $('friends-results');
    this.search = $('friends-search');
    this.timer = null;
    this.searchTimer = null;
    this.searchToken = 0;
    this.listToken = 0;
    /** The last list_friends rows shown (kept on errors). */
    this.rows = [];
    this.lastSearch = [];
    /** userId → timeout of a pending "Remove?" */
    this.removeArmed = new Map();
    /** The home screen is showing (MainMenu.show / hide). */
    this.shown = false;
    /** Narrow window: the sidebar is a button, `open` while it lies over the menu. */
    this.collapsed = false;
    this.open = false;
    this.toggle.addEventListener('click', () => { game.audio.playUI('click'); this.setOpen(!this.open); });
    this.search.addEventListener('focus', () => { game.input.textInputActive = true; });
    this.search.addEventListener('blur', () => { game.input.textInputActive = false; });
    // Game keys never fire while typing (textInputActive); Esc clears the search first, then leaves the box / closes the overlay.
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); this.escape(); } });
    this.search.addEventListener('input', () => this._searchSoon());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.shown && this.collapsed && this.open && document.activeElement !== this.search) { e.preventDefault(); this.setOpen(false); } });
    window.addEventListener('resize', () => { if (this.shown) this.layout(); });
    game.events.on('gui:scale', () => { if (this.shown) this.layout(); });
    game.events.on('friends:waiting', () => this.refreshToggle()); // "Friends (2)" on the collapsed button while requests wait
  }

  /** On screen right now: the home screen is up and the sidebar is docked or opened over it. */
  get visible() { return this.shown && !this.menu.classList.contains('hidden') && (!this.collapsed || this.open); }

  /** The home screen appeared: lay out for the window, refresh now and every 5 s while it stays (the search bar is not focused). */
  show() {
    this.shown = true;
    this.layout();
    this.setNote('');
    this.refresh();
    this._stopTimer();
    this.timer = setInterval(() => { if (this.shown && !document.hidden) this.refresh(); }, REFRESH_MS);
  }

  /** The home screen went away (the world list, the server list, Settings, a world): no more refreshes until it returns. */
  hide() {
    this.shown = false;
    this._stopTimer();
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    this.setOpen(false);
    if (document.activeElement === this.search) this.search.blur();
    this.game.input.textInputActive = false;
  }

  _stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Docked beside the menu, or collapsed to the corner button when the window is too narrow for both. */
  layout() {
    const scale = this.game.guiScale ? this.game.guiScale.scale : 2;
    const w = window.innerWidth;
    this.collapsed = w < COLLAPSE_BELOW_GUI * scale || w < COLLAPSE_BELOW_PX;
    this.menu.classList.toggle('friends-collapsed', this.collapsed);
    if (!this.collapsed) this.setOpen(false);
    this.refreshToggle();
  }

  /** The collapsed sidebar over the menu (the button again, or Esc, closes it). */
  setOpen(open) {
    this.open = !!open && this.collapsed;
    this.menu.classList.toggle('friends-open', this.open);
    this.toggle.setAttribute('aria-expanded', String(this.open));
    if (!this.open && document.activeElement === this.search) this.search.blur();
  }

  /** Esc: clear the search first; with nothing to clear leave the box, and close the overlay in a narrow window. */
  escape() {
    if (this.search.value) { this.search.value = ''; this._searchSoon(); return; }
    if (document.activeElement === this.search) this.search.blur();
    if (this.collapsed && this.open) this.setOpen(false);
  }

  refreshToggle() { const n = this.game.presence ? this.game.presence.waiting : 0; this.toggle.textContent = n > 0 ? `Friends (${n})` : 'Friends'; }

  /** The one-line note: a result sentence, or (`setError`) the connection error in red. */
  setNote(text) { this.note.textContent = text || ''; this.note.classList.remove('error'); }
  setError(text) {
    if (text) { this.note.textContent = text; this.note.classList.add('error'); }
    else if (this.note.classList.contains('error')) { this.note.textContent = ''; this.note.classList.remove('error'); }
  }

  // ---- search ----

  _searchSoon() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const q = this.search.value.trim();
    if (q.length < 2) { this.lastSearch = []; this._renderResults(); return; }
    this.searchTimer = setTimeout(() => { this.searchTimer = null; this.runSearch(q); }, SEARCH_DEBOUNCE_MS);
  }

  /** search_users for `q` (2+ characters); a newer search wins over an older answer. */
  async runSearch(q) {
    const token = ++this.searchToken;
    if (q.length < 2) { this.lastSearch = []; this._renderResults(); return; }
    try {
      const res = await this.game.cloud.rpc('search_users', { p_query: q });
      if (res.error) throw new Error(res.error.message);
      if (token !== this.searchToken) return;
      this.lastSearch = res.data || [];
      this.setError('');
    } catch (e) {
      if (token !== this.searchToken) return;
      this.setError(FRIENDS_ERROR_TEXT);
    }
    this._renderResults();
  }

  /** The results above the search bar: one compact row per name with the button its relation calls for. */
  _renderResults() {
    this.results.textContent = '';
    for (const r of this.lastSearch) {
      const row = document.createElement('div');
      row.className = 'friend-result';
      row.dataset.user = r.id;
      const name = document.createElement('span'); name.className = 'friend-title'; name.textContent = r.username; name.title = r.username;
      row.appendChild(name);
      if (r.relation === 'friends') { const t = document.createElement('span'); t.className = 'friend-tag'; t.textContent = 'Friends'; row.appendChild(t); }
      else {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'mc-button small';
        if (r.relation === 'sent') { b.textContent = 'Requested'; b.disabled = true; b.classList.add('friend-requested'); }
        else if (r.relation === 'received') { b.textContent = 'Accept'; b.classList.add('friend-accept'); b.addEventListener('click', () => { this.game.audio.playUI('click'); this.respond(r.id, true); }); }
        else { b.textContent = 'Add'; b.classList.add('friend-add'); b.addEventListener('click', () => { this.game.audio.playUI('click'); this.add(r.username); }); }
        row.appendChild(b);
      }
      this.results.appendChild(row);
    }
  }

  // ---- actions (every one refreshes the list at once) ----

  async _call(name, args) {
    try {
      const res = await this.game.cloud.rpc(name, args);
      if (res.error) throw new Error(res.error.message);
      this.setError('');
      return { ok: true, data: res.data };
    } catch (e) { this.setError(FRIENDS_ERROR_TEXT); return { ok: false, data: null }; }
  }

  _searchAgain() { const q = this.search.value.trim(); if (q.length >= 2) this.runSearch(q); }

  async add(username) {
    const r = await this._call('send_friend_request', { p_username: username });
    if (r.ok) this.setNote(sendResultText(r.data, username));
    await this.refresh();
    this._searchAgain();
  }

  async respond(userId, accept) {
    await this._call('respond_friend_request', { p_user: userId, p_accept: !!accept });
    await this.refresh();
    this._searchAgain();
  }

  /** Remove a friend, or cancel a request I sent. */
  async remove(userId) {
    const t = this.removeArmed.get(userId);
    if (t) { clearTimeout(t); this.removeArmed.delete(userId); }
    await this._call('remove_friend', { p_user: userId });
    await this.refresh();
    this._searchAgain();
  }

  /** The × button: the first click arms "Remove?" for 3 s; the second removes. */
  _removeClick(userId, button) {
    if (this.removeArmed.has(userId)) { this.remove(userId); return; }
    button.textContent = 'Remove?';
    button.classList.add('armed', 'danger');
    const t = setTimeout(() => { this.removeArmed.delete(userId); if (button.isConnected) { button.textContent = '×'; button.classList.remove('armed', 'danger'); } }, REMOVE_CONFIRM_MS);
    this.removeArmed.set(userId, t);
  }

  /** Join a friend's server exactly like the server list's Join (the same lobby shape); the loading screen replaces the menu. */
  join(r) {
    const lobby = { id: r.lobby_id, host_id: r.lobby_host_id, host_name: r.lobby_host_name, world_name: r.lobby_world_name, player_count: r.player_count, max_players: r.max_players, same_network: !!r.same_network };
    this.game.joinServer(lobby);
  }

  // ---- the list ----

  /** list_friends with the cached network hash; the waiting count follows the received requests. */
  async refresh() {
    const g = this.game;
    if (!g.cloud || !g.account || !g.account.loggedIn) return;
    const token = ++this.listToken;
    try {
      if (!g.networkInfo) g.networkInfo = await detectNetworkHash({ mock: g.cloudMock });
      const info = g.networkInfo;
      const res = await g.cloud.rpc('list_friends', { p_network_hash: info.detected ? info.hash : null });
      if (res.error) throw new Error(res.error.message);
      if (token !== this.listToken) return;
      this.rows = Array.isArray(res.data) ? res.data : [];
      this.setError('');
      if (g.presence) g.presence.setWaiting(this.rows.filter((r) => r.relation === 'received').length);
    } catch (e) {
      if (token !== this.listToken) return;
      this.setError(FRIENDS_ERROR_TEXT); // the list keeps its last content
    }
    this._render();
  }

  _render() {
    const rows = this.rows;
    const requests = rows.filter((r) => r.relation !== 'friends');
    const friends = rows.filter((r) => r.relation === 'friends');
    const online = friends.filter((r) => r.online).sort((a, b) => a.username.localeCompare(b.username));
    const offline = friends.filter((r) => !r.online).sort((a, b) => a.username.localeCompare(b.username));
    this.online.textContent = `· ${online.length} online`;
    const btn = (text, cls, fn, title = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mc-button small ' + cls; b.textContent = text; if (title) b.title = title; b.addEventListener('click', () => { this.game.audio.playUI('click'); fn(b); }); return b; };
    const nameOf = (r, dot) => {
      const name = document.createElement('div'); name.className = 'friend-name';
      if (dot) { const d = document.createElement('span'); d.className = 'friend-dot'; name.appendChild(d); }
      const title = document.createElement('span'); title.className = 'friend-title'; title.textContent = r.username; title.title = r.username; name.appendChild(title);
      return name;
    };
    // Requests: only when there are any
    const req = this.requests;
    req.textContent = '';
    if (requests.length) {
      const h = document.createElement('div'); h.className = 'friends-sub'; h.id = 'friends-requests-title'; h.textContent = `Requests (${requests.length})`; req.appendChild(h);
      for (const r of requests) {
        const row = document.createElement('div'); row.className = 'friend-entry friend-request'; row.dataset.user = r.id; row.dataset.relation = r.relation;
        const info = document.createElement('div'); info.className = 'friend-info'; info.appendChild(nameOf(r, false));
        if (r.relation === 'sent') { const meta = document.createElement('div'); meta.className = 'friend-status'; meta.textContent = 'Waiting…'; info.appendChild(meta); }
        row.appendChild(info);
        const actions = document.createElement('div'); actions.className = 'friend-actions';
        if (r.relation === 'received') actions.append(btn('Accept', 'friend-accept', () => this.respond(r.id, true)), btn('Decline', 'friend-decline', () => this.respond(r.id, false)));
        else actions.appendChild(btn('Cancel', 'friend-cancel', () => this.remove(r.id)));
        row.appendChild(actions);
        req.appendChild(row);
      }
    }
    // Friends: online first, then offline
    const list = this.list;
    list.textContent = '';
    if (!friends.length) { const empty = document.createElement('div'); empty.className = 'friends-empty'; empty.textContent = NO_FRIENDS_TEXT; list.appendChild(empty); this.refreshToggle(); return; }
    for (const r of [...online, ...offline]) {
      const row = document.createElement('div'); row.className = 'friend-entry' + (r.online ? ' online' : ' offline'); row.dataset.user = r.id; row.dataset.status = r.online ? r.status : 'offline';
      const info = document.createElement('div'); info.className = 'friend-info';
      const meta = document.createElement('div'); meta.className = 'friend-status';
      const [text, world] = statusParts(r);
      meta.appendChild(document.createTextNode(text));
      if (world !== null) { const w = document.createElement('span'); w.className = 'friend-world'; w.textContent = world; meta.appendChild(w); }
      meta.title = meta.textContent;
      info.append(nameOf(r, true), meta);
      row.appendChild(info);
      const actions = document.createElement('div'); actions.className = 'friend-actions';
      if (r.lobby_id) {
        if (r.same_network) { const badge = document.createElement('span'); badge.className = 'lobby-badge friend-lan'; badge.textContent = 'Same Wi-Fi'; badge.title = 'On your Wi-Fi'; actions.appendChild(badge); }
        const full = r.player_count >= r.max_players;
        const j = btn(full ? 'Full' : 'Join', 'friend-join', () => this.join(r), full ? 'The server is full' : `Join ${r.lobby_world_name || 'their world'}`);
        j.disabled = full;
        actions.appendChild(j);
      }
      actions.appendChild(btn('×', 'friend-remove', (b) => this._removeClick(r.id, b), 'Remove'));
      row.appendChild(actions);
      list.appendChild(row);
    }
    this.refreshToggle();
  }
}
