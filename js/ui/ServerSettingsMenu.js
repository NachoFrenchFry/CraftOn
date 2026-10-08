// ServerSettingsMenu.js — the host's "Server Settings" screen (Update #9 §1), opened from the pause menu while
// hosting (in single player the same screen is "World Settings" with only the world toggles: PvP, keep inventory): the default game mode for new players, the host's own mode, and per player a mode selector plus a
// "Can change own game mode" toggle (off by default). Everything is saved in the host's world
// (meta.defaultGameMode, meta.guests[id].mode / canChangeMode) and applied to connected guests at once.
const MODES = ['survival', 'creative', 'spectator'];
const cap = (m) => m.charAt(0).toUpperCase() + m.slice(1);

export class ServerSettingsMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('server-settings');
    this.defaultSel = document.getElementById('srv-default-mode');
    this.hostSel = document.getElementById('srv-host-mode');
    this.list = document.getElementById('srv-players');
    this.title = document.getElementById('srv-title');
    this.pvp = document.getElementById('srv-pvp');
    this.keepInv = document.getElementById('srv-keep-inv');
    this.hostOnly = [...this.root.querySelectorAll('.srv-host-only')];
    this.onDone = null;
    // World settings (Update #9 §8): PvP (hosting only) and keep inventory, saved in the world, sent to guests.
    this.pvp.addEventListener('change', () => { game.audio.playUI('click'); this._setWorld('pvp', this.pvp.checked); });
    this.keepInv.addEventListener('change', () => { game.audio.playUI('click'); this._setWorld('keepInventory', this.keepInv.checked); });
    this.defaultSel.addEventListener('change', () => { game.audio.playUI('click'); if (game.net && game.net.isHost) game.net.setDefaultMode(this.defaultSel.value); });
    this.hostSel.addEventListener('change', () => { game.audio.playUI('click'); game.setGameMode(this.hostSel.value); });
    document.getElementById('btn-srv-back').addEventListener('click', () => { game.audio.playUI('click'); this.close(); });
    game.events.on('net:changed', () => { if (this.visible) this.refresh(); });
    game.events.on('gamemode:changed', () => { if (this.visible) this.hostSel.value = game.player.gameMode; });
  }

  get visible() { return !this.root.classList.contains('hidden'); }

  open(onDone) { this.onDone = onDone; this.refresh(); this.root.classList.remove('hidden'); }
  /** Done: back to whoever opened the screen (the pause menu). */
  close() { this.root.classList.add('hidden'); const cb = this.onDone; this.onDone = null; if (cb) cb(); }
  /** Hidden by a state change (the game resumed): no callback. */
  hide() { this.root.classList.add('hidden'); this.onDone = null; }

  _setWorld(key, value) {
    const g = this.game;
    if (!g.worldMeta) return;
    g.worldMeta[key] = value;
    g.session.changedSinceSave = true;
    if (g.net && g.net.isHost) g.net.broadcastWorldSettings();
  }

  refresh() {
    const g = this.game, net = g.net, meta = g.worldMeta;
    const hosting = !!(net && net.isHost);
    this.title.textContent = hosting ? 'Server Settings' : 'World Settings';
    for (const el of this.hostOnly) el.classList.toggle('hidden', !hosting);
    this.pvp.checked = !meta || meta.pvp !== false;
    this.keepInv.checked = !!(meta && meta.keepInventory);
    this.list.textContent = '';
    if (!hosting) return;
    this.defaultSel.value = net.defaultMode;
    this.hostSel.value = this.game.player.gameMode;
    const rows = net.guestRows();
    if (!rows.length) { const e = document.createElement('div'); e.className = 'srv-empty'; e.textContent = 'No one has joined yet.'; this.list.appendChild(e); return; }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'srv-row' + (r.online ? ' online' : '');
      row.dataset.userId = r.userId;
      const name = document.createElement('span'); name.className = 'srv-name'; name.textContent = r.name + (r.online ? '' : ' (offline)'); row.appendChild(name);
      const sel = document.createElement('select'); sel.className = 'srv-mode';
      for (const m of MODES) { const o = document.createElement('option'); o.value = m; o.textContent = cap(m); sel.appendChild(o); }
      sel.value = r.mode;
      sel.addEventListener('change', () => { this.game.audio.playUI('click'); net.setGuestMode(r.userId, sel.value); });
      row.appendChild(sel);
      const lab = document.createElement('label'); lab.className = 'srv-perm';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'srv-can-change'; cb.checked = !!r.canChangeMode;
      cb.addEventListener('change', () => { this.game.audio.playUI('click'); net.setGuestCanChange(r.userId, cb.checked); });
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' Can change own game mode'));
      row.appendChild(lab);
      this.list.appendChild(row);
    }
  }
}
