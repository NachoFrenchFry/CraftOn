// ControlsTab.js — the key-binding part of the Settings screen's Controls tab (its Mouse Sensitivity, Invert Mouse Y and
// Crouch mode rows come from OptionsTab / SettingRow): the hint line, the grouped list of actions, each with up to three
// keys shown as chips (click a chip to replace that key, × to remove it, + to add one; keyboard and mouse buttons),
// per-key conflict highlighting, per-action reset and "Reset All to Defaults" at the end. Esc while waiting for a key
// cancels only the listening (InputManager swallows that key), so the Settings screen stays open.

import { ACTIONS, ACTION_GROUPS, MAX_KEYS_PER_ACTION, describeKey } from '../config/KeyBindings.js';

export class ControlsTab {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {HTMLElement} list  the tab's scrolling list (the option rows are already in it)
   * @param {() => boolean} visible  whether the Settings screen is open (chips are redrawn on changes only then)
   */
  constructor(game, list, visible) {
    this.game = game;
    this.store = game.keybinds;
    this.visible = visible;
    /** { action, index } while waiting for a key (index = the chip being replaced, or the list length for "+"). */
    this.listening = null;
    /** action id → { row, keys, resetButton } */
    this.rows = new Map();
    const hint = document.createElement('div');
    hint.className = 'controls-hint';
    hint.textContent = 'Every action can have up to three keys or mouse buttons: click a key to change it, + to add one, × to remove it, then press any key or mouse button. Esc cancels. Esc and the mouse wheel cannot be rebound.';
    this.list = document.createElement('div');
    this.list.id = 'bind-list'; this.list.className = 'bind-list';
    const resetAll = document.createElement('button');
    resetAll.id = 'btn-binds-reset-all'; resetAll.type = 'button'; resetAll.className = 'mc-button'; resetAll.textContent = 'Reset All to Defaults';
    resetAll.addEventListener('click', () => {
      game.audio.playUI('click');
      if (!confirm('Reset every key binding to its default?')) return;
      this.stopListening();
      this.store.resetAll();
      this.refresh();
    });
    list.append(hint, this.list, resetAll);
    this._build();
    game.events.on('keybinds:changed', () => { if (this.visible()) this.refresh(); });
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
        row.dataset.action = action.id;
        const name = document.createElement('span');
        name.className = 'bind-label';
        name.textContent = action.label;
        const keys = document.createElement('div');
        keys.className = 'bind-keys';
        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'mc-button bind-reset';
        resetButton.textContent = 'Reset';
        resetButton.addEventListener('click', () => { this.game.audio.playUI('click'); this.stopListening(); this.store.reset(action.id); this.refresh(); });
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
      keyButton.type = 'button';
      keyButton.className = 'mc-button bind-key' + (this.store.codeHasConflict(code) ? ' conflict' : '') + (listening === index ? ' listening' : '');
      keyButton.textContent = listening === index ? '> Press a key <' : describeKey(code);
      if (this.store.codeHasConflict(code)) {
        const others = this.store.actionsFor(code).filter((a) => a !== id).map((a) => ACTIONS.find((x) => x.id === a)?.label || a);
        keyButton.title = `${describeKey(code)} is also bound to: ${others.join(', ')}`;
      }
      keyButton.addEventListener('click', (e) => { e.stopPropagation(); this._startListening(id, index); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mc-button bind-chip-remove';
      remove.textContent = '×';
      remove.title = 'Remove this key';
      remove.addEventListener('click', (e) => { e.stopPropagation(); this.game.audio.playUI('click'); this.stopListening(); this.store.remove(id, code); this.refresh(); });
      chip.append(keyButton, remove);
      row.keys.appendChild(chip);
    });
    if (codes.length < MAX_KEYS_PER_ACTION) {
      const add = document.createElement('button');
      add.type = 'button';
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
    this.stopListening();
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

  /** Cancel a pending key capture (Done, Esc handled by the input, another tab, a reset). */
  stopListening() {
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
  }
}
