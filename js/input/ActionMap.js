// ActionMap.js — resolves named game actions to live key/mouse state through the KeyBindingStore.

export class ActionMap {
  /**
   * @param {import('./InputManager.js').InputManager} input
   * @param {import('../core/KeyBindingStore.js').KeyBindingStore} store
   */
  constructor(input, store) {
    this.input = input;
    this.store = store;
  }

  /** True while the bound key for the action is held. */
  isActive(action) {
    const code = this.store.get(action);
    return code !== '' && this.input.isDown(code);
  }

  /** True on the frame the bound key went down. */
  wasPressed(action) {
    const code = this.store.get(action);
    return code !== '' && this.input.wasPressed(code);
  }

  /** True on the frame the bound key was pressed for the second time within ~300 ms. */
  wasDoubleTapped(action) {
    const code = this.store.get(action);
    return code !== '' && this.input.wasDoubleTapped(code);
  }

  wasReleased(action) {
    const code = this.store.get(action);
    return code !== '' && this.input.wasReleased(code);
  }

  /** Actions bound to a raw code (used by key event dispatch). */
  actionsFor(code) {
    return this.store.actionsFor(code);
  }
}
