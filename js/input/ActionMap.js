// ActionMap.js — resolves named game actions to live key/mouse state through the KeyBindingStore. An action is
// active / pressed when any of its (up to three) keys is.

export class ActionMap {
  /**
   * @param {import('./InputManager.js').InputManager} input
   * @param {import('../core/KeyBindingStore.js').KeyBindingStore} store
   */
  constructor(input, store) {
    this.input = input;
    this.store = store;
  }

  _codes(action) { return this.store.bindings[action] || []; }

  /** True while any bound key for the action is held. */
  isActive(action) {
    for (const code of this._codes(action)) if (this.input.isDown(code)) return true;
    return false;
  }

  /** True on the frame a bound key went down. */
  wasPressed(action) {
    for (const code of this._codes(action)) if (this.input.wasPressed(code)) return true;
    return false;
  }

  /** True on the frame a bound key was pressed for the second time within ~300 ms. */
  wasDoubleTapped(action) {
    for (const code of this._codes(action)) if (this.input.wasDoubleTapped(code)) return true;
    return false;
  }

  wasReleased(action) {
    for (const code of this._codes(action)) if (this.input.wasReleased(code)) return true;
    return false;
  }

  /** Actions bound to a raw code (used by key event dispatch). */
  actionsFor(code) {
    return this.store.actionsFor(code);
  }
}
