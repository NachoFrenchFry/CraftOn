// ControlsMenu.js — the key-binding screen: grouped list of actions, each with up to three keys shown as chips (click a
// chip to replace that key, × to remove it, + to add one; keyboard and mouse buttons), per-key conflict highlighting,
// per-action reset, "Reset All to Defaults", the Crouch mode (Hold / Toggle) option and Done.

import { ACTIONS, ACTION_GROUPS, MAX_KEYS_PER_ACTION, describeKey } from '../config/KeyBindings.js';

export class ControlsMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.store = game.keybinds;
    this.root = document.getElementById('controls-menu');
    this.list = document.getElementById('bind-list');
    this.onDone = null;
    /** { action, index } while waiting for a key (index = the chip being replaced, or the list length for "+"). */
    this.listening = null;
    /** action id → { row, keys, resetButton } */
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
    game.events.on('settings:changed', (key) => { if (key === 'crouchMode' && this.crouchSelect) this.crouchSelect.value = game.settings.get('crouchMode'); });
  }

  _build() {
    // Crouch mode (Hold / Toggle), a setting that lives on this screen.
    const option = document.createElement('div');
    option.className = 'option-row bind-option';
    const label = document.createElement('label');
    const text = document.createElement('span'); text.textContent = 'Crouch mode';
    const select = document.createElement('select');
    select.id = 'crouch-mode';
    for (const [value, name] of [['hold', 'Hold'], ['toggle', 'Toggle']]) { const o = document.createElement('option'); o.value = value; o.textContent = name; select.appendChild(o); }
    select.value = this.game.settings.get('crouchMode');
    select.addEventListener('change', () => { this.game.audio.playUI('click'); this.game.settings.set('crouchMode', select.value === 'toggle' ? 'toggle' : 'hold'); });
    label.append(text, select);
    option.appendChild(label);
    this.list.appendChild(option);
    this.crouchSelect = select;
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
        row.dataset.action = action.id;
        const name = document.createElement('span');
        name.className = 'bind-label';
        name.textContent = action.label;
        const keys = document.createElement('div');
        keys.className = 'bind-keys';
        const resetButton = document.createElement('button');
        resetButton.className = 'mc-button bind-reset';
        resetButton.textContent = 'Reset';
        resetButton.addEventListener('click', () => { this.game.audio.playUI('click'); this._stopListening(); this.store.reset(action.id); this.refresh(); });
        row.append(name, keys, resetButton);
        this.list.appendChild(row);
        this.rows.set(action.id, { row, keys, resetButton });
      }
    }
  }

  /** Rebuild one row's chips: a button per key (click = replace), × per key, and + while there is room. */
  _renderKeys(id, row) {
    const codes = this.store.get(id);
    const listening = this.listening && this.listening.action === id ? this.listening.index : -1;
    row.keys.textContent = '';
    codes.forEach((code, index) => {
      const chip = document.createElement('span');
      chip.className = 'bind-chip' + (this.store.codeHasConflict(code) ? ' conflict' : '');
      chip.dataset.code = code;
      const keyButton = document.createElement('button');
      keyButton.className = 'mc-button bind-key' + (this.store.codeHasConflict(code) ? ' conflict' : '') + (listening === index ? ' listening' : '');
      keyButton.textContent = listening === index ? '> Press a key <' : describeKey(code);
      if (this.store.codeHasConflict(code)) {
        const others = this.store.actionsFor(code).filter((a) => a !== id).map((a) => ACTIONS.find((x) => x.id === a)?.label || a);
        keyButton.title = `${describeKey(code)} is also bound to: ${others.join(', ')}`;
      }
      keyButton.addEventListener('click', (e) => { e.stopPropagation(); this._startListening(id, index); });
      const remove = document.createElement('button');
      remove.className = 'mc-button bind-chip-remove';
      remove.textContent = '×';
      remove.title = 'Remove this key';
      remove.addEventListener('click', (e) => { e.stopPropagation(); this.game.audio.playUI('click'); this._stopListening(); this.store.remove(id, code); this.refresh(); });
      chip.append(keyButton, remove);
      row.keys.appendChild(chip);
    });
    if (codes.length < MAX_KEYS_PER_ACTION) {
      const add = document.createElement('button');
      add.className = 'mc-button bind-add' + (listening === codes.length ? ' listening' : '');
      add.textContent = listening === codes.length ? '> Press a key <' : '+';
      add.title = 'Add a key or mouse button';
      add.addEventListener('click', (e) => { e.stopPropagation(); this._startListening(id, codes.length); });
      row.keys.appendChild(add);
    }
  }

  /** Wait for the next key / mouse button for one chip (index) or a new key (index = list length). */
  _startListening(actionId, index) {
    this.game.audio.playUI('click');
    this._stopListening();
    this.listening = { action: actionId, index };
    this.refresh();
    this.game.input.beginCapture((code) => {
      const target = this.listening;
      this.listening = null;
      if (code && target) {
        if (this.store.replaceAt(target.action, target.index, code)) this.game.audio.playUI('click', 0.6);
      }
      this.refresh();
    });
  }

  _stopListening() {
    if (!this.listening) return;
    this.game.input.cancelCapture();
    this.listening = null;
    this.refresh();
  }

  /** Update every row's chips, conflict state and reset availability. */
  refresh() {
    for (const [id, row] of this.rows) {
      this._renderKeys(id, row);
      row.resetButton.disabled = this.store.isDefault(id);
    }
    if (this.crouchSelect) this.crouchSelect.value = this.game.settings.get('crouchMode');
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
