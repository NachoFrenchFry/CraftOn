// KeyBindingStore.js — the live key bindings: defaults merged with the player's changes, saved in localStorage (this
// device only). Every action holds a list of up to MAX_KEYS_PER_ACTION codes; ActionMap reads from here, so changes
// apply instantly. Saved data from the one-key-per-action days (a string per action) is read as a one-element list, and
// a sneak / sprint pair still on the old Shift / Ctrl defaults follows the new C / Shift defaults.

import { ACTIONS, DEFAULT_BINDINGS, LEGACY_DEFAULTS, RESERVED_CODES, ALWAYS_PREVENT_DEFAULT, MAX_KEYS_PER_ACTION } from '../config/KeyBindings.js';

const STORAGE_KEY = 'crafton.keybinds.v1';

const validCode = (code) => typeof code === 'string' && code.length > 0 && code.length < 40 && !RESERVED_CODES.has(code);
const sameList = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

export class KeyBindingStore {
  /** @param {import('./EventBus.js').EventBus} events */
  constructor(events) {
    this.events = events;
    /** action id → code list */
    this.bindings = this._defaults();
    /** code → action ids (rebuilt on every change) */
    this.byCode = new Map();
    this.preventCodes = new Set();
    this.load();
    this._rebuild();
  }

  _defaults() { return Object.fromEntries(ACTIONS.map((a) => [a.id, [...DEFAULT_BINDINGS[a.id]]])); }

  /** Merge saved bindings over the defaults; unknown actions are dropped, bad data is ignored. */
  load() {
    this.bindings = this._defaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const legacyFormat = ACTIONS.some((a) => typeof parsed[a.id] === 'string');
      for (const action of ACTIONS) {
        const v = parsed[action.id];
        const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
        if (!list) continue;
        const codes = [...new Set(list.filter(validCode))].slice(0, MAX_KEYS_PER_ACTION);
        this.bindings[action.id] = codes;
      }
      if (legacyFormat) this._migrateLegacyDefaults(parsed);
    } catch (e) {
      console.warn('KeyBindingStore: stored bindings are corrupt, using defaults', e);
      this.bindings = this._defaults();
    }
  }

  /** A one-key save whose sneak / sprint still sit on the old defaults gets the new ones (customised keys stay). */
  _migrateLegacyDefaults(parsed) {
    for (const [action, oldCode] of Object.entries(LEGACY_DEFAULTS)) {
      if (parsed[action] !== oldCode) continue;
      const fresh = DEFAULT_BINDINGS[action];
      const taken = ACTIONS.some((a) => a.id !== action && this.bindings[a.id].includes(fresh[0]) && !sameList(this.bindings[a.id], DEFAULT_BINDINGS[a.id]));
      if (!taken) this.bindings[action] = [...fresh];
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
    for (const [action, codes] of Object.entries(this.bindings)) {
      for (const code of codes) {
        if (!this.byCode.has(code)) this.byCode.set(code, []);
        this.byCode.get(code).push(action);
        if (!code.startsWith('Mouse')) this.preventCodes.add(code);
      }
    }
  }

  _changed() {
    this._rebuild();
    this.save();
    this.events.emit('keybinds:changed', this.bindings);
  }

  /** The codes bound to an action (a copy; empty when unbound). */
  get(action) { return this.bindings[action] ? [...this.bindings[action]] : []; }
  /** The first code of an action ('' when unbound). */
  first(action) { const l = this.bindings[action]; return l && l.length ? l[0] : ''; }

  /** Replace an action's whole key list. Returns false for unknown actions or reserved keys. */
  set(action, codes) {
    if (!(action in DEFAULT_BINDINGS)) return false;
    const list = (typeof codes === 'string' ? [codes] : Array.isArray(codes) ? codes : []);
    if (list.some((c) => !validCode(c))) return false;
    const clean = [...new Set(list)].slice(0, MAX_KEYS_PER_ACTION);
    if (sameList(clean, this.bindings[action])) return true;
    this.bindings[action] = clean;
    this._changed();
    return true;
  }

  /** Add a key to an action (no-op when already there; false when the list is full or the key is reserved). */
  add(action, code) {
    if (!(action in DEFAULT_BINDINGS) || !validCode(code)) return false;
    const list = this.bindings[action];
    if (list.includes(code)) return true;
    if (list.length >= MAX_KEYS_PER_ACTION) return false;
    return this.set(action, [...list, code]);
  }

  /** Replace the key at `index` of an action's list (or append when the index is past the end). */
  replaceAt(action, index, code) {
    if (!(action in DEFAULT_BINDINGS) || !validCode(code)) return false;
    const list = [...this.bindings[action]];
    if (index < 0 || index >= list.length) return this.add(action, code);
    list[index] = code;
    return this.set(action, list);
  }

  remove(action, code) {
    if (!(action in DEFAULT_BINDINGS)) return false;
    return this.set(action, this.bindings[action].filter((c) => c !== code));
  }

  reset(action) {
    if (!(action in DEFAULT_BINDINGS)) return;
    this.bindings[action] = [...DEFAULT_BINDINGS[action]];
    this._changed();
  }

  resetAll() {
    this.bindings = this._defaults();
    this._changed();
  }

  isDefault(action) { return sameList(this.bindings[action] || [], DEFAULT_BINDINGS[action] || []); }

  /** Actions currently bound to a code. */
  actionsFor(code) { return this.byCode.get(code) || []; }

  /** True when another action also uses this code. */
  codeHasConflict(code) { return this.actionsFor(code).length > 1; }

  /** True when any of the action's keys is also used by another action. */
  hasConflict(action) { return (this.bindings[action] || []).some((c) => this.codeHasConflict(c)); }

  /** Whether the browser default for a key should be suppressed while playing. */
  shouldPreventDefault(code) { return this.preventCodes.has(code); }
}
