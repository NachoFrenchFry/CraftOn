// ControlsMenu.js — the key-binding screen: grouped list of actions, click-to-rebind (keyboard and
// mouse buttons), conflict highlighting, per-action reset, "Reset All to Defaults" and Done.

import { ACTIONS, ACTION_GROUPS, describeKey } from '../config/KeyBindings.js';

export class ControlsMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.store = game.keybinds;
    this.root = document.getElementById('controls-menu');
    this.list = document.getElementById('bind-list');
    this.onDone = null;
    this.listeningAction = null;
    /** action id → { keyButton, resetButton } */
    this.rows = new Map();
    this._build();
    document.getElementById('btn-binds-done').addEventListener('click', () => { game.audio.playUI('click'); this.close(); });
    document.getElementById('btn-binds-reset-all').addEventListener('click', () => {
      game.audio.playUI('click');
      if (!confirm('Reset every key binding to its default?')) return;
      this._stopListening();
      this.store.resetAll();
      this.refresh();
    });
    game.events.on('keybinds:changed', () => { if (!this.root.classList.contains('hidden')) this.refresh(); });
  }

  _build() {
    for (const group of ACTION_GROUPS) {
      const actions = ACTIONS.filter((a) => a.group === group);
      if (!actions.length) continue;
      const header = document.createElement('div');
      header.className = 'bind-group';
      header.textContent = group;
      this.list.appendChild(header);
      for (const action of actions) {
        const row = document.createElement('div');
        row.className = 'bind-row';
        const label = document.createElement('span');
        label.className = 'bind-label';
        label.textContent = action.label;
        const keyButton = document.createElement('button');
        keyButton.className = 'mc-button bind-key';
        keyButton.addEventListener('click', (e) => { e.stopPropagation(); this._startListening(action.id); });
        const resetButton = document.createElement('button');
        resetButton.className = 'mc-button bind-reset';
        resetButton.textContent = 'Reset';
        resetButton.addEventListener('click', () => { this.game.audio.playUI('click'); this._stopListening(); this.store.reset(action.id); this.refresh(); });
        row.append(label, keyButton, resetButton);
        this.list.appendChild(row);
        this.rows.set(action.id, { keyButton, resetButton });
      }
    }
  }

  /** Wait for the next key / mouse button. The click that started listening is already over. */
  _startListening(actionId) {
    this.game.audio.playUI('click');
    this._stopListening();
    this.listeningAction = actionId;
    const row = this.rows.get(actionId);
    row.keyButton.textContent = '> Press a key <';
    row.keyButton.classList.add('listening');
    this.game.input.beginCapture((code) => {
      const action = this.listeningAction;
      this.listeningAction = null;
      if (code && action) {
        this.store.set(action, code);
        this.game.audio.playUI('click', 0.6);
      }
      this.refresh();
    });
  }

  _stopListening() {
    if (!this.listeningAction) return;
    this.game.input.cancelCapture();
    this.listeningAction = null;
    this.refresh();
  }

  /** Update every row's key name, conflict state and reset availability. */
  refresh() {
    for (const [id, row] of this.rows) {
      const code = this.store.get(id);
      const conflict = this.store.hasConflict(id);
      if (this.listeningAction !== id) {
        row.keyButton.textContent = describeKey(code);
        row.keyButton.classList.remove('listening');
      }
      row.keyButton.classList.toggle('conflict', conflict);
      if (conflict) {
        const others = this.store.actionsFor(code).filter((a) => a !== id).map((a) => ACTIONS.find((x) => x.id === a)?.label || a);
        row.keyButton.title = `${describeKey(code)} is also bound to: ${others.join(', ')}`;
      } else {
        row.keyButton.title = '';
      }
      row.resetButton.disabled = this.store.isDefault(id);
    }
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  open(onDone) {
    this.onDone = onDone;
    this.refresh();
    this.root.classList.remove('hidden');
  }

  close() {
    this._stopListening();
    this.root.classList.add('hidden');
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }
}
