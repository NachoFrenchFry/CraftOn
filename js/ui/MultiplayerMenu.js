// MultiplayerMenu.js — the Multiplayer screens (Update #8): Host Server (pick one of your cloud worlds or create
// one, choose the player limit, play and publish the lobby), Find Server (lobbies on this Wi-Fi, auto-refreshed
// every 3 s, plus Join by code), the "Signed in somewhere else" kick screen (Reconnect / Log out) and the
// "The host closed the server" notice.

import { State } from '../core/GameState.js';
import { hashSeed, randomSeed } from '../utils/Random.js';
import { detectNetworkHash } from '../net/NetworkId.js';
import { GAME_VERSION, JOIN_CODE_PATTERN, MAX_PLAYERS_MIN, MAX_PLAYERS_MAX } from '../net/Protocol.js';

const FIND_REFRESH_MS = 3000;

export class MultiplayerMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    const $ = (id) => document.getElementById(id);
    this.root = $('multiplayer-menu');
    this.hostRoot = $('host-menu');
    this.findRoot = $('find-menu');
    this.kickedRoot = $('kicked-menu');
    this.discRoot = $('disconnected-menu');
    this.hostList = $('host-world-list');
    this.hostError = $('host-error');
    this.hostMax = $('host-max');
    this.hostName = $('host-name');
    this.hostSeed = $('host-seed');
    this.hostMode = $('host-mode');
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
    for (let n = MAX_PLAYERS_MIN; n <= MAX_PLAYERS_MAX; n++) { const o = document.createElement('option'); o.value = String(n); o.textContent = String(n); if (n === MAX_PLAYERS_MAX) o.selected = true; this.hostMax.appendChild(o); }
    const click = (id, fn) => $(id).addEventListener('click', () => { game.audio.playUI('click'); fn(); });
    click('btn-mp-host', () => this.showHost());
    click('btn-mp-find', () => this.showFind());
    click('btn-mp-back', () => { this.hideAll(); game.ui.mainMenu.show(); });
    click('btn-host-back', () => this.showMain());
    click('btn-find-back', () => this.showMain());
    click('btn-host-create', () => this._createAndHost());
    click('btn-find-refresh', () => this._refreshLobbies(true));
    click('btn-join-code', () => this._joinByCode());
    click('btn-kicked-reconnect', () => this._reconnect());
    click('btn-kicked-logout', () => game.logout());
    click('btn-disconnected-ok', () => this.discRoot.classList.add('hidden'));
    for (const input of [this.hostName, this.hostSeed, this.joinCode]) {
      input.addEventListener('focus', () => { game.input.textInputActive = true; });
      input.addEventListener('blur', () => { game.input.textInputActive = false; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (input === this.joinCode) this._joinByCode(); else this._createAndHost(); } e.stopPropagation(); });
    }
  }

  // ---- screens ----

  showMain() {
    this.hideAll();
    this.game.ui.mainMenu.hide();
    this.root.classList.remove('hidden');
  }

  /** Hide every multiplayer screen (the kick screen too unless `keepKicked`). */
  hideAll(keepKicked = false) {
    for (const el of [this.root, this.hostRoot, this.findRoot, this.discRoot]) el.classList.add('hidden');
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
    if (!worlds.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No saved worlds yet. Create one below to host it.'; this.hostList.appendChild(empty); return; }
    for (const w of worlds) {
      const row = document.createElement('div');
      row.className = 'world-entry';
      const info = document.createElement('div'); info.className = 'world-info';
      const name = document.createElement('div'); name.className = 'world-name'; name.textContent = w.name;
      const meta = document.createElement('div'); meta.className = 'world-meta'; meta.textContent = `seed ${w.seedText || w.seed} · ${w.gameMode}`;
      info.append(name, meta);
      const host = document.createElement('button'); host.className = 'mc-button small'; host.textContent = 'Host';
      host.addEventListener('click', () => { this.game.audio.playUI('click'); this._host(w.id); });
      row.append(info, host);
      this.hostList.appendChild(row);
    }
  }

  _setHostError(text) { this.hostError.textContent = text || ''; this.hostError.classList.toggle('hidden', !text); }

  async _host(worldId) {
    if (this.busy) return;
    this.busy = true;
    const max = parseInt(this.hostMax.value, 10) || MAX_PLAYERS_MAX;
    this.hideAll();
    try {
      const ok = await this.game.hostWorld(worldId, max);
      if (!ok && !this.game.state.inWorld) { await this.showHost(); this._setHostError("Couldn't start the server."); }
    } finally { this.busy = false; }
  }

  async _createAndHost() {
    if (this.busy) return;
    const name = this.hostName.value.trim() || 'New World';
    const seedText = this.hostSeed.value.trim();
    const seed = seedText ? hashSeed(seedText) : randomSeed();
    this.hostCreate.disabled = true; this.hostCreate.innerHTML = '<span class="spinner"></span>Creating…';
    let record;
    try { record = await this.game.saveManager.createWorld({ name, seed, seedText, gameMode: this.hostMode.value }); }
    catch (e) { this._setHostError("Couldn't create the world. Check your connection."); return; }
    finally { this.hostCreate.disabled = false; this.hostCreate.textContent = 'Create New World & Host'; }
    this._host(record.id);
  }

  /** The lobby list for this network, refreshed every 3 s while the screen is open; `error` shows a message (a failed join). */
  showFind(error = null) {
    this.hideAll();
    this.game.ui.mainMenu.hide();
    this.findRoot.classList.remove('hidden');
    this._setFindError(error || '');
    this.findStatus.innerHTML = '<span class="spinner"></span>Searching your network…';
    this.findList.innerHTML = '';
    this._refreshLobbies();
    this.findTimer = setInterval(() => this._refreshLobbies(), FIND_REFRESH_MS);
  }

  _stopPolling() { if (this.findTimer) { clearInterval(this.findTimer); this.findTimer = null; } }
  _setFindError(text) { this.findError.textContent = text || ''; this.findError.classList.toggle('hidden', !text); }

  async _refreshLobbies(manual = false) {
    const g = this.game;
    if (this.findRoot.classList.contains('hidden')) return;
    if (manual) this.findStatus.innerHTML = '<span class="spinner"></span>Searching your network…';
    try {
      if (!g.networkInfo) g.networkInfo = await detectNetworkHash({ mock: g.cloudMock });
      const info = g.networkInfo;
      if (!info.detected) { this.findStatus.textContent = "Couldn't detect your network. Ask the host for the code and use Join by code."; this.findList.innerHTML = ''; return; }
      const res = await g.cloud.rpc('find_lobbies', { p_network_hash: info.hash });
      if (res.error) throw new Error(res.error.message);
      this.lobbies = res.data || [];
    } catch (e) {
      this.findStatus.textContent = "Couldn't reach the server. Check your connection.";
      return;
    }
    this._renderLobbies();
  }

  _renderLobbies() {
    const list = this.lobbies;
    this.findList.innerHTML = '';
    if (!list.length) { this.findStatus.textContent = 'No servers found on your network.'; return; }
    this.findStatus.textContent = `${list.length} server${list.length === 1 ? '' : 's'} on your network`;
    for (const l of list) {
      const row = document.createElement('div');
      row.className = 'world-entry lobby-entry';
      row.dataset.lobby = l.id;
      const info = document.createElement('div'); info.className = 'world-info';
      const name = document.createElement('div'); name.className = 'world-name'; name.textContent = l.world_name;
      const meta = document.createElement('div'); meta.className = 'world-meta';
      const mismatch = l.game_version !== GAME_VERSION;
      const full = l.player_count >= l.max_players;
      meta.textContent = `${l.host_name} · ${l.player_count}/${l.max_players} players` + (mismatch ? ' · Different game version' : full ? ' · Full' : '');
      info.append(name, meta);
      const join = document.createElement('button'); join.className = 'mc-button small'; join.textContent = 'Join';
      join.disabled = mismatch || full;
      join.addEventListener('click', () => { this.game.audio.playUI('click'); this._join(l); });
      row.append(info, join);
      this.findList.appendChild(row);
    }
  }

  async _join(lobby) {
    if (this.busy) return;
    this.busy = true;
    this._stopPolling();
    this.hideAll();
    try { await this.game.joinServer(lobby); } finally { this.busy = false; }
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
      if (l.game_version !== GAME_VERSION) { this._setFindError('Different game version.'); return; }
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
