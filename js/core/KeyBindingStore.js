// KeyBindingStore.js — the live key bindings: defaults merged with the player's changes, saved in
// localStorage (this device only). ActionMap reads from here, so changes apply instantly.

import { ACTIONS, DEFAULT_BINDINGS, RESERVED_CODES, ALWAYS_PREVENT_DEFAULT } from '../config/KeyBindings.js';

const STORAGE_KEY = 'crafton.keybinds.v1';

export class KeyBindingStore {
  /** @param {import('./EventBus.js').EventBus} events */
  constructor(events) {
    this.events = events;
    /** action id → code */
    this.bindings = { ...DEFAULT_BINDINGS };
    /** code → action ids (rebuilt on every change) */
    this.byCode = new Map();
    this.preventCodes = new Set();
    this.load();
    this._rebuild();
  }

  /** Merge saved bindings over the defaults; unknown actions are dropped, bad data is ignored. */
  load() {
    this.bindings = { ...DEFAULT_BINDINGS };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const action of ACTIONS) {
        const code = parsed[action.id];
        if (typeof code === 'string' && code.length > 0 && code.length < 40 && !RESERVED_CODES.has(code)) this.bindings[action.id] = code;
      }
    } catch (e) {
      console.warn('KeyBindingStore: stored bindings are corrupt, using defaults', e);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch (e) {
      console.warn('KeyBindingStore: could not save bindings', e);
    }
  }

  _rebuild() {
    this.byCode.clear();
    this.preventCodes = new Set(ALWAYS_PREVENT_DEFAULT);
    for (const [action, code] of Object.entries(this.bindings)) {
      if (!this.byCode.has(code)) this.byCode.set(code, []);
      this.byCode.get(code).push(action);
      if (!code.startsWith('Mouse')) this.preventCodes.add(code);
    }
  }

  _changed() {
    this._rebuild();
    this.save();
    this.events.emit('keybinds:changed', this.bindings);
  }

  /** Code bound to an action ('' when unbound). */
  get(action) { return this.bindings[action] || ''; }

  /** Bind an action to a code. Returns false for reserved keys. */
  set(action, code) {
    if (!(action in DEFAULT_BINDINGS) || RESERVED_CODES.has(code) || typeof code !== 'string') return false;
    if (this.bindings[action] === code) return true;
    this.bindings[action] = code;
    this._changed();
    return true;
  }

  reset(action) {
    if (!(action in DEFAULT_BINDINGS)) return;
    this.bindings[action] = DEFAULT_BINDINGS[action];
    this._changed();
  }

  resetAll() {
    this.bindings = { ...DEFAULT_BINDINGS };
    this._changed();
  }

  isDefault(action) { return this.bindings[action] === DEFAULT_BINDINGS[action]; }

  /** Actions currently bound to a code. */
  actionsFor(code) { return this.byCode.get(code) || []; }

  /** True when more than one action uses the action's code. */
  hasConflict(action) { return this.actionsFor(this.bindings[action]).length > 1; }

  /** Whether the browser default for a key should be suppressed while playing. */
  shouldPreventDefault(code) { return this.preventCodes.has(code); }
}
