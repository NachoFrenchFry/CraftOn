// EventBus.js — tiny synchronous pub/sub used to decouple subsystems.

export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  /** Subscribe; returns an unsubscribe function. */
  on(event, fn) {
    let list = this.listeners.get(event);
    if (!list) { list = []; this.listeners.set(event, list); }
    list.push(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const list = this.listeners.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(event, ...args) {
    const list = this.listeners.get(event);
    if (!list) return;
    // Copy so listeners may unsubscribe during dispatch. Every argument is forwarded (block:changed has four).
    const snapshot = list.slice();
    for (let i = 0; i < snapshot.length; i++) snapshot[i](...args);
  }
}
