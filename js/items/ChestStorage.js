// ChestStorage.js — the 36 slots of one chest, with the Inventory-like slot API the inventory screen drives (get / set
// / split / addItem / changed). `onChange(storage, slot)` fires after every change (slot −1 = everything): the
// ChestManager writes the contents into the chunk's edit data and, on a server, the host broadcasts the slot.

import { ItemStack } from './ItemStack.js';
import { CHEST_SLOTS } from '../config/Constants.js';

export class ChestStorage {
  /**
   * @param {string} key "x,y,z" of the chest block
   * @param {Array|null} data serialized slots ([[id, n] | 0, …]) or null for an empty chest
   * @param {(storage: ChestStorage, slot: number) => void} onChange
   */
  constructor(key, data = null, onChange = null) {
    this.key = key;
    this.size = CHEST_SLOTS;
    this.slots = ChestStorage.deserialize(data);
    this.onChange = onChange;
    this.selectedIndex = -1;
  }

  get(i) { return this.slots[i] ?? null; }

  set(i, stack) {
    if (i < 0 || i >= this.size) return;
    this.slots[i] = stack && stack.count > 0 ? stack : null;
    this.changed(i);
  }

  changed(i = -1) { if (this.onChange) this.onChange(this, i); }

  /** Chests take any item in any slot. */
  acceptsAt() { return true; }
  static isArmorIndex() { return false; }

  /** Split half of a slot into a new stack (returned). */
  split(i) {
    const s = this.slots[i];
    if (!s) return null;
    const half = s.splitHalf();
    if (s.count <= 0) this.slots[i] = null;
    this.changed(i);
    return half;
  }

  /** Add items (existing stacks first, then empty slots); returns the leftover. */
  addItem(itemId, count) {
    let remaining = count;
    const probe = new ItemStack(itemId, remaining);
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.itemId === itemId && s.count < s.maxStack) { probe.count = remaining; const before = remaining; s.absorb(probe); remaining = probe.count; if (remaining !== before) this.changed(i); }
    }
    for (let i = 0; i < this.size && remaining > 0; i++) {
      if (this.slots[i] === null) { const take = Math.min(remaining, probe.maxStack); this.slots[i] = new ItemStack(itemId, take); remaining -= take; this.changed(i); }
    }
    return remaining;
  }

  isEmpty() { return this.slots.every((s) => !s); }

  /** Compact form for the chunk edit data and the network: [[id, n] | 0, …] (36 entries). */
  serialize() { return this.slots.map((s) => (s ? [s.itemId, s.count] : 0)); }

  /** Replace every slot from the compact form (a host CHEST_CONTENTS, or the chunk data). */
  load(data) { this.slots = ChestStorage.deserialize(data); this.changed(-1); }

  static deserialize(data) {
    const slots = new Array(CHEST_SLOTS).fill(null);
    if (!Array.isArray(data)) return slots;
    for (let i = 0; i < CHEST_SLOTS && i < data.length; i++) {
      const d = data[i];
      if (Array.isArray(d) && d.length >= 2) slots[i] = ItemStack.deserialize({ id: d[0], n: d[1] });
      else if (d && typeof d === 'object') slots[i] = ItemStack.deserialize(d);
    }
    return slots;
  }
}
