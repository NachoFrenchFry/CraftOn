// MainMenu.js — title screen (shows who is logged in, with Log out) and the world select/create panel: the
// list comes from the cloud (name, seed, mode, last played) with a Retry when the server cannot be reached.
// The list is prefetched as soon as the session is known (Game.prefetchWorlds), shows a spinner while it
// loads, and Create / Delete / Log out disable their buttons with a spinner until the server answers.

import { hashSeed, randomSeed } from '../utils/Random.js';

export class MainMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('main-menu');
    this.worldRoot = document.getElementById('world-menu');
    this.worldList = document.getElementById('world-list');
    this.nameInput = document.getElementById('world-name');
    this.seedInput = document.getElementById('world-seed');
    this.modeSelect = document.getElementById('world-mode');
    this.accountLine = document.getElementById('menu-account');
    this.worldError = document.getElementById('world-error');
    this.worldRetry = document.getElementById('btn-worlds-retry');
    this.createButton = document.getElementById('btn-create-world');
    this.logoutButton = document.getElementById('btn-logout');
    this.listToken = 0;
    this.busy = false;
    const ui = game.ui;
    this.logoutButton.addEventListener('click', async () => {
      if (this.logoutButton.disabled) return;
      game.audio.playUI('click');
      this._busyButton(this.logoutButton, 'Logging out…');
      try { await game.logout(); } finally { this._busyButton(this.logoutButton, null, 'Log out'); }
    });
    this.worldRetry.addEventListener('click', () => { game.audio.playUI('click'); this.refreshList(); });
    game.events.on('account:changed', () => this.refreshAccount());
    document.getElementById('btn-play').addEventListener('click', () => { game.audio.playUI('click'); this.showWorlds(); });
    document.getElementById('btn-multiplayer').addEventListener('click', () => { game.audio.playUI('click'); ui.multiplayer.showMain(); });
    document.getElementById('btn-options').addEventListener('click', () => { game.audio.playUI('click'); ui.options.open(() => this.show()); this.hide(); });
    document.getElementById('btn-world-back').addEventListener('click', () => { game.audio.playUI('click'); this.hideWorlds(); this.show(); });
    document.getElementById('btn-create-world').addEventListener('click', () => this._create());
    for (const input of [this.nameInput, this.seedInput]) {
      input.addEventListener('focus', () => { game.input.textInputActive = true; });
      input.addEventListener('blur', () => { game.input.textInputActive = false; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._create(); e.stopPropagation(); });
    }
  }

  show() { this.refreshAccount(); this.root.classList.remove('hidden'); }

  /** Put a spinner + label on a button and disable it (label null = restore `restoreText`). */
  _busyButton(button, label, restoreText = '') {
    const busy = label !== null;
    button.disabled = busy;
    button.classList.toggle('busy', busy);
    if (busy) button.innerHTML = `<span class="spinner"></span>${label}`;
    else button.textContent = restoreText;
  }

  /** Creating a world: the form and every world row are frozen until the server answers. */
  _setBusy(busy, label = 'Creating…') {
    this.busy = busy;
    for (const el of [this.nameInput, this.seedInput, this.modeSelect]) el.disabled = busy;
    for (const b of this.worldList.querySelectorAll('button')) b.disabled = busy;
    this._busyButton(this.createButton, busy ? label : null, 'Create New World');
  }

  refreshAccount() { const u = this.game.account && this.game.account.username; this.accountLine.textContent = u ? `Logged in as ${u}` : ''; }
  hide() { this.root.classList.add('hidden'); }

  async showWorlds() {
    this.hide();
    this.worldRoot.classList.remove('hidden');
    await this.refreshList();
  }

  hideWorlds() { this.worldRoot.classList.add('hidden'); }

  showError(text) {
    this.worldError.textContent = text || '';
    this.worldError.classList.toggle('hidden', !text);
    this.worldRetry.classList.toggle('hidden', !text);
  }

  async refreshList() {
    this.showError('');
    this.worldList.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'empty world-loading';
    loading.innerHTML = '<span class="spinner"></span>Loading your worlds…';
    this.worldList.appendChild(loading);
    const token = ++this.listToken; // a newer refresh wins over an older answer
    let worlds;
    try {
      worlds = await this.game.takeWorldList(); // prefetched at login / boot when possible
    } catch (e) {
      if (token !== this.listToken) return;
      console.warn('MainMenu: world list failed', e);
      this.worldList.innerHTML = '';
      this.showError("Couldn't load your worlds. Check your connection.");
      return;
    }
    if (token !== this.listToken) return;
    this.worldList.innerHTML = '';
    if (!worlds.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No saved worlds yet. Create one below.';
      this.worldList.appendChild(empty);
      return;
    }
    for (const w of worlds) {
      const row = document.createElement('div');
      row.className = 'world-entry';
      const info = document.createElement('div');
      info.className = 'world-info';
      const name = document.createElement('div');
      name.className = 'world-name';
      name.textContent = w.name;
      const meta = document.createElement('div');
      meta.className = 'world-meta';
      meta.textContent = `seed ${w.seedText || w.seed} · ${w.gameMode} · last played ${w.lastPlayed ? new Date(w.lastPlayed).toLocaleString() : 'never'}`;
      info.append(name, meta);
      const play = document.createElement('button');
      play.className = 'mc-button small';
      play.textContent = 'Play';
      play.addEventListener('click', () => { if (this.busy) return; this.game.audio.playUI('click'); this.hideWorlds(); this.game.startWorld(w.id); });
      const del = document.createElement('button');
      del.className = 'mc-button small danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (this.busy) return;
        this.game.audio.playUI('click');
        if (!confirm(`Delete world "${w.name}"? This cannot be undone.`)) return;
        this._setBusy(true, 'Create New World');
        this._busyButton(del, 'Deleting…');
        try { await this.game.saveManager.deleteWorld(w.id); } catch (e) { this._setBusy(false); this._busyButton(del, null, 'Delete'); this.showError("Couldn't delete the world. Check your connection."); return; }
        this._setBusy(false);
        this.refreshList();
      });
      row.append(info, play, del);
      this.worldList.appendChild(row);
    }
  }

  async _create() {
    if (this.busy) return;
    this.game.audio.playUI('click');
    const name = this.nameInput.value.trim() || 'New World';
    const seedText = this.seedInput.value.trim();
    const seed = seedText ? hashSeed(seedText) : randomSeed();
    const gameMode = this.modeSelect.value;
    this.showError('');
    this._setBusy(true, 'Creating…');
    let record;
    try { record = await this.game.saveManager.createWorld({ name, seed, seedText, gameMode }); } catch (e) { this._setBusy(false); this.showError("Couldn't create the world. Check your connection."); return; }
    this._setBusy(false);
    this.hideWorlds();
    this.game.startWorld(record.id);
  }
}
