// MainMenu.js — title screen (shows who is logged in, with Log out; the Friends sidebar on its right, FriendsSidebar.js) and the world select/create panel: the
// list comes from the cloud (name, seed, mode, last played) with a Retry when the server cannot be reached.
// The list is prefetched as soon as the session is known (Game.prefetchWorlds), shows a spinner while it
// loads, and Create / Delete / Log out disable their buttons with a spinner until the server answers. The create screen
// holds the one Create World form (CreateWorldForm.js, shared with Multiplayer → Host New Server) with every world setting.

import { CreateWorldForm } from './CreateWorldForm.js';
import { modeName, lockedText } from '../core/WorldSettings.js';

/** The row's name line and meta line with the world's tags: a green Pure Survival badge after the name, a gray Locked tag after the mode. */
export function worldRowLines(w) {
  const name = document.createElement('div');
  name.className = 'world-name';
  const title = document.createElement('span'); title.textContent = w.name; name.appendChild(title);
  if (w.survivalOnly) { const t = document.createElement('span'); t.className = 'tag tag-green'; t.textContent = 'Pure Survival'; t.title = 'Only ever played in Survival, without cheats'; name.appendChild(t); }
  const meta = document.createElement('div');
  meta.className = 'world-meta';
  meta.appendChild(document.createTextNode(`seed ${w.seedText || w.seed} · ${w.gameMode}`));
  if (w.modeLocked) { const t = document.createElement('span'); t.className = 'tag tag-gray'; t.textContent = 'Locked'; t.title = lockedText(w.gameMode); meta.appendChild(t); }
  return { name, meta };
}

export class MainMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('main-menu');
    this.worldRoot = document.getElementById('world-menu');
    /** The "Create New World" form on its own screen. */
    this.createRoot = document.getElementById('create-world-menu');
    this.createError = document.getElementById('create-error');
    this.worldList = document.getElementById('world-list');
    /** The shared Create World form (controls world-name, world-seed, world-gameMode, …). */
    this.form = new CreateWorldForm(game, document.getElementById('create-world-form'), { idPrefix: 'world', onSubmit: () => this._create() });
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
    const fade = (change) => ui.fade(change); // every move between full menu screens goes through black (Nov 15 2026)
    document.getElementById('btn-play').addEventListener('click', () => { game.audio.playUI('click'); fade(() => this.showWorlds()); });
    document.getElementById('btn-multiplayer').addEventListener('click', () => { game.audio.playUI('click'); fade(() => ui.multiplayer.showMain()); });
    document.getElementById('btn-options').addEventListener('click', () => { game.audio.playUI('click'); fade(() => { ui.settings.open(() => fade(() => this.show())); this.hide(); }); }); // "Settings" from the home screen fades both ways (from the pause menu it is instant)
    document.getElementById('btn-world-back').addEventListener('click', () => { game.audio.playUI('click'); fade(() => { this.hideWorlds(); this.show(); }); });
    document.getElementById('btn-new-world').addEventListener('click', () => { game.audio.playUI('click'); fade(() => this.showCreate()); });
    document.getElementById('btn-create-back').addEventListener('click', () => { game.audio.playUI('click'); fade(() => { this.hideCreate(); this.showWorlds(); }); });
    document.getElementById('btn-create-world').addEventListener('click', () => this._create());
  }

  /** The home screen, with the Friends sidebar (FriendsSidebar.js) that refreshes only while it is up. */
  show() { this.refreshAccount(); this.root.classList.remove('hidden'); this.game.ui.friends.show(); }

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
    this.form.setBusy(busy);
    for (const b of this.worldList.querySelectorAll('button')) b.disabled = busy;
    this._busyButton(this.createButton, busy ? label : null, 'Create');
  }

  refreshAccount() { const u = this.game.account && this.game.account.username; this.accountLine.textContent = u ? `Logged in as ${u}` : ''; }

  hide() { this.root.classList.add('hidden'); this.game.ui.friends.hide(); }

  async showWorlds() {
    this.hide();
    this.worldRoot.classList.remove('hidden');
    await this.refreshList();
  }

  hideWorlds() { this.worldRoot.classList.add('hidden'); this.hideCreate(); }

  /** The create form (every world setting, back at its defaults) on its own screen; Back returns to the list. */
  showCreate() {
    this.worldRoot.classList.add('hidden');
    this.createRoot.classList.remove('hidden');
    this.createError.textContent = ''; this.createError.classList.add('hidden');
    this.form.reset(); // a fresh form every time: the last world's name, seed and mode never leak into the next one
    this.form.focus();
  }

  hideCreate() { this.createRoot.classList.add('hidden'); this.game.input.textInputActive = false; }

  showError(text) {
    this.worldError.textContent = text || '';
    this.worldError.classList.toggle('hidden', !text);
    this.worldRetry.classList.toggle('hidden', !text);
  }

  _showCreateError(text) { this.createError.textContent = text || ''; this.createError.classList.toggle('hidden', !text); }

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
      empty.textContent = 'No saved worlds yet. Use "Create New World".';
      this.worldList.appendChild(empty);
      return;
    }
    for (const w of worlds) {
      const row = document.createElement('div');
      row.className = 'world-entry';
      const info = document.createElement('div');
      info.className = 'world-info';
      const { name, meta } = worldRowLines(w);
      meta.appendChild(document.createTextNode(` · last played ${w.lastPlayed ? new Date(w.lastPlayed).toLocaleString() : 'never'}`));
      info.append(name, meta);
      const play = document.createElement('button');
      play.className = 'mc-button small';
      play.textContent = 'Play';
      play.addEventListener('click', () => { if (this.busy) return; this.game.audio.playUI('click'); this.game.startWorld(w.id); }); // the LOADING state hides the list — at black when the fades are on
      const del = document.createElement('button');
      del.className = 'mc-button small danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (this.busy) return;
        this.game.audio.playUI('click');
        if (!confirm(`Delete world "${w.name}"? This cannot be undone.`)) return;
        this._setBusy(true, 'Create');
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
    const settings = this.form.values(); // name, seed, game mode and every world setting (createWorld stores them all)
    this._showCreateError('');
    if (settings.modeLocked && !(await this.game.ui.confirm.ask(`Lock this world to ${modeName(settings.gameMode)} forever?`, { ok: 'Lock it', cancel: 'Cancel' }))) return; // the lock can never be turned off
    this._setBusy(true, 'Creating…');
    let record;
    try { record = await this.game.saveManager.createWorld(settings); } catch (e) { this._setBusy(false); this._showCreateError("Couldn't create the world. Check your connection."); return; }
    this._setBusy(false);
    this.game.startWorld(record.id); // the LOADING state hides the create screen, at black
  }
}
