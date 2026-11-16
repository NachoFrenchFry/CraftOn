// MultiplayerMenu.js — the Multiplayer screens. The first screen is the server list: every public
// server online plus the private ones on this network (list_lobbies, refreshed every 3 s and with Refresh), each with
// the world name, host, players, a LAN badge for the same network and Join; "Join by code" at the top; "Host New
// Server" opens the host flow (pick one of your cloud worlds or create one with the shared Create World form, choose
// Public / Private and the player limit). Also the "Signed in somewhere else" kick screen (Reconnect / Log out) and the
// disconnect notice.

import { State } from '../core/GameState.js';
import { CreateWorldForm } from './CreateWorldForm.js';
import { worldRowLines } from './MainMenu.js';
import { modeName } from '../core/WorldSettings.js';
import { detectNetworkHash } from '../net/NetworkId.js';
import { JOIN_CODE_PATTERN, MAX_PLAYERS_MIN, MAX_PLAYERS_MAX } from '../net/Protocol.js';

const FIND_REFRESH_MS = 3000;
export const EMPTY_LIST_TEXT = 'No servers online right now. Host one!';

export class MultiplayerMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    const $ = (id) => document.getElementById(id);
    this.root = $('multiplayer-menu');
    this.hostRoot = $('host-menu');
    this.hostCreateRoot = $('host-create-menu');
    this.hostCreateError = $('host-create-error');
    this.kickedRoot = $('kicked-menu');
    this.discRoot = $('disconnected-menu');
    this.hostList = $('host-world-list');
    this.hostError = $('host-error');
    this.hostMax = $('host-max');
    this.hostVisibility = $('host-visibility');
    /** The shared Create World form, the hosting copy (controls host-name, host-seed, host-gameMode, …). */
    this.hostForm = new CreateWorldForm(game, $('host-create-form'), { idPrefix: 'host', onSubmit: () => this._createAndHost() });
    this.hostCreate = $('btn-host-create');
    this.findList = $('find-list');
    this.findStatus = $('find-status');
    this.findError = $('find-error');
    this.joinCode = $('join-code');
    this.joinButton = $('btn-join-code');
    this.kickedError = $('kicked-error');
    this.discText = $('disconnected-text');
    this.findTimer = null;
    this.busy = false;
    this.lobbies = [];
    this.lastRefresh = 0;
    for (let n = MAX_PLAYERS_MIN; n <= MAX_PLAYERS_MAX; n++) { const o = document.createElement('option'); o.value = String(n); o.textContent = String(n); if (n === MAX_PLAYERS_MAX) o.selected = true; this.hostMax.appendChild(o); }
    const click = (id, fn) => $(id).addEventListener('click', () => { game.audio.playUI('click'); fn(); });
    const fade = (change) => game.ui.fade(change); // every move between full menu screens goes through black (Nov 15 2026)
    click('btn-mp-host', () => fade(() => this.showHost()));
    click('btn-mp-back', () => fade(() => { this.hideAll(); game.ui.mainMenu.show(); }));
    click('btn-host-back', () => fade(() => this.showMain()));
    click('btn-host-new', () => fade(() => this.showHostCreate()));
    click('btn-host-create-back', () => fade(() => this.showHost()));
    click('btn-host-create', () => this._createAndHost());
    click('btn-find-refresh', () => this._refreshLobbies(true));
    click('btn-join-code', () => this._joinByCode());
    click('btn-kicked-reconnect', () => this._reconnect());
    click('btn-kicked-logout', () => game.logout());
    click('btn-disconnected-ok', () => this.discRoot.classList.add('hidden'));
    this.joinCode.addEventListener('focus', () => { game.input.textInputActive = true; });
    this.joinCode.addEventListener('blur', () => { game.input.textInputActive = false; });
    this.joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._joinByCode(); e.stopPropagation(); });
  }

  // ---- screens ----

  /** The server list (the first Multiplayer screen); `error` shows a message (a failed join). */
  showMain(error = null) {
    this.hideAll();
    this.game.ui.mainMenu.hide();
    this.root.classList.remove('hidden');
    this._setFindError(error || '');
    this.findStatus.innerHTML = '<span class="spinner"></span>Looking for servers…';
    this.findList.innerHTML = '';
    this._refreshLobbies();
    this.findTimer = setInterval(() => this._refreshLobbies(), FIND_REFRESH_MS);
  }

  /** Kept for callers of the old Find screen: the list with an error line. */
  showFind(error = null) { this.showMain(error); }

  /** Hide every multiplayer screen (the kick screen too unless `keepKicked`). */
  hideAll(keepKicked = false) {
    for (const el of [this.root, this.hostRoot, this.hostCreateRoot, this.discRoot]) el.classList.add('hidden');
    if (!keepKicked) this.kickedRoot.classList.add('hidden');
    this._stopPolling();
    this.game.input.textInputActive = false;
  }

  async showHost() {
    this.hideAll();
    this.game.ui.mainMenu.hide();
    this.hostRoot.classList.remove('hidden');
    this._setHostError('');
    this.hostList.innerHTML = '<div class="empty world-loading"><span class="spinner"></span>Loading your worlds…</div>';
    let worlds;
    try { worlds = await this.game.takeWorldList(); } catch (e) { this.hostList.innerHTML = ''; this._setHostError("Couldn't load your worlds. Check your connection."); return; }
    this.hostList.innerHTML = '';
    if (!worlds.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No saved worlds yet. Use "Create New World" to make one and host it.'; this.hostList.appendChild(empty); return; }
    for (const w of worlds) {
      const row = document.createElement('div');
      row.className = 'world-entry';
      const info = document.createElement('div'); info.className = 'world-info';
      const { name, meta } = worldRowLines(w); // the Pure Survival and Locked tags too
      info.append(name, meta);
      const host = document.createElement('button'); host.className = 'mc-button small'; host.textContent = 'Host';
      host.addEventListener('click', () => { this.game.audio.playUI('click'); this._host(w.id); });
      row.append(info, host);
      this.hostList.appendChild(row);
    }
  }

  _setHostError(text) { this.hostError.textContent = text || ''; this.hostError.classList.toggle('hidden', !text); }

  /** The create form for hosting, on its own screen; Back returns to the world picker. */
  showHostCreate() {
    this.hideAll();
    this.game.ui.mainMenu.hide();
    this.hostCreateRoot.classList.remove('hidden');
    this.hostCreateError.textContent = ''; this.hostCreateError.classList.add('hidden');
    this.hostForm.reset(); // a fresh form every time
    this.hostForm.focus();
  }

  /** The hosting options chosen on the Host screen. */
  hostOptions() {
    return { maxPlayers: parseInt(this.hostMax.value, 10) || MAX_PLAYERS_MAX, visibility: this.hostVisibility.value === 'private' ? 'private' : 'public' };
  }

  async _host(worldId) {
    if (this.busy) return;
    this.busy = true;
    const opts = this.hostOptions();
    try {
      const ok = await this.game.hostWorld(worldId, opts); // the LOADING state hides this screen, at black
      if (!ok && !this.game.state.inWorld) this.game.ui.fade(() => { this.showHost().then(() => this._setHostError("Couldn't start the server.")); });
    } finally { this.busy = false; }
  }

  async _createAndHost() {
    if (this.busy) return;
    const settings = this.hostForm.values(); // the same rows as Play → Create New World
    if (settings.modeLocked && !(await this.game.ui.confirm.ask(`Lock this world to ${modeName(settings.gameMode)} forever?`, { ok: 'Lock it', cancel: 'Cancel' }))) return;
    this.hostCreate.disabled = true; this.hostCreate.innerHTML = '<span class="spinner"></span>Creating…';
    this.hostForm.setBusy(true);
    let record;
    try { record = await this.game.saveManager.createWorld(settings); }
    catch (e) { this.hostCreateError.textContent = "Couldn't create the world. Check your connection."; this.hostCreateError.classList.remove('hidden'); return; }
    finally { this.hostCreate.disabled = false; this.hostCreate.textContent = 'Create & Host'; this.hostForm.setBusy(false); }
    this._host(record.id);
  }

  _stopPolling() { if (this.findTimer) { clearInterval(this.findTimer); this.findTimer = null; } }
  _setFindError(text) { this.findError.textContent = text || ''; this.findError.classList.toggle('hidden', !text); }

  /** list_lobbies: every public server plus the private ones on this network (same network first). */
  async _refreshLobbies(manual = false) {
    const g = this.game;
    if (this.root.classList.contains('hidden') || this.refreshing) return;
    this.refreshing = true;
    if (manual) this.findStatus.innerHTML = '<span class="spinner"></span>Looking for servers…';
    try {
      if (!g.networkInfo) g.networkInfo = await detectNetworkHash({ mock: g.cloudMock });
      const info = g.networkInfo;
      const res = await g.cloud.rpc('list_lobbies', { p_network_hash: info.detected ? info.hash : null });
      if (res.error) throw new Error(res.error.message);
      const me = g.account && g.account.session ? g.account.session.user.id : null;
      this.lobbies = (res.data || []).filter((l) => l.host_id !== me);
      this.lastRefresh = Date.now();
    } catch (e) {
      this.findStatus.textContent = "Couldn't reach the server. Check your connection.";
      this.refreshing = false;
      return;
    }
    this.refreshing = false;
    if (this.root.classList.contains('hidden')) return;
    this._renderLobbies();
  }

  _renderLobbies() {
    const list = this.lobbies;
    const g = this.game;
    this.findList.innerHTML = '';
    if (!list.length) {
      this.findStatus.textContent = g.networkInfo && !g.networkInfo.detected ? "Couldn't detect your network: private servers on it are not listed." : '';
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = EMPTY_LIST_TEXT;
      this.findList.appendChild(empty);
      return;
    }
    const lan = list.filter((l) => l.same_network).length;
    this.findStatus.textContent = `${list.length} server${list.length === 1 ? '' : 's'} online` + (lan ? ` · ${lan} on your network` : '');
    for (const l of list) {
      const row = document.createElement('div');
      row.className = 'world-entry lobby-entry';
      row.dataset.lobby = l.id;
      const info = document.createElement('div'); info.className = 'world-info';
      const name = document.createElement('div'); name.className = 'world-name';
      const title = document.createElement('span'); title.textContent = l.world_name; name.appendChild(title);
      if (l.same_network) { const badge = document.createElement('span'); badge.className = 'lobby-badge'; badge.textContent = 'LAN'; badge.title = 'On your network'; name.appendChild(badge); }
      const meta = document.createElement('div'); meta.className = 'world-meta';
      const full = l.player_count >= l.max_players;
      meta.textContent = `${l.host_name} · ${l.player_count}/${l.max_players} players`;
      if (full) { const note = document.createElement('span'); note.className = 'lobby-note'; note.textContent = ' · Full'; meta.appendChild(note); row.classList.add('unavailable'); }
      info.append(name, meta);
      const join = document.createElement('button'); join.className = 'mc-button small'; join.textContent = 'Join';
      join.disabled = full;
      join.title = full ? 'The server is full' : '';
      join.addEventListener('click', () => { this.game.audio.playUI('click'); this._join(l); });
      row.append(info, join);
      this.findList.appendChild(row);
    }
  }

  async _join(lobby) {
    if (this.busy) return;
    this.busy = true;
    this._stopPolling();
    try { await this.game.joinServer(lobby); } finally { this.busy = false; } // the LOADING state hides the list, at black when the fades are on
  }

  async _joinByCode() {
    const code = this.joinCode.value.trim().toUpperCase();
    if (!JOIN_CODE_PATTERN.test(code)) { this._setFindError('Join codes are 6 letters or digits.'); return; }
    this.joinButton.disabled = true; this.joinButton.innerHTML = '<span class="spinner"></span>Looking…';
    try {
      const res = await this.game.cloud.rpc('find_lobby_by_code', { p_code: code });
      if (res.error) throw new Error(res.error.message);
      const l = res.data && res.data[0];
      if (!l) { this._setFindError('No server with that code is open right now.'); return; }
      this._join(l);
    } catch (e) { this._setFindError("Couldn't reach the server. Check your connection."); }
    finally { this.joinButton.disabled = false; this.joinButton.textContent = 'Join by code'; }
  }

  // ---- kicked / disconnected ----

  showKicked() { this.hideAll(true); this.kickedRoot.classList.remove('hidden'); this.setKickedError(''); }
  hideKicked() { this.kickedRoot.classList.add('hidden'); }
  setKickedError(text) { this.kickedError.textContent = text || ''; this.kickedError.classList.toggle('hidden', !text); }
  async _reconnect() {
    const b = document.getElementById('btn-kicked-reconnect');
    b.disabled = true; b.innerHTML = '<span class="spinner"></span>Reconnecting…';
    try { await this.game.reconnect(); } finally { b.disabled = false; b.textContent = 'Reconnect'; }
  }

  showDisconnected(text) {
    this.discText.textContent = text;
    this.discRoot.classList.remove('hidden');
  }

  get isKickedShown() { return this.game.state.is(State.KICKED); }
}
