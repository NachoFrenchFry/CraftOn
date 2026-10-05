// ItemStack.js — a stack of one item type with a count, plus merge/split helpers.

import { ItemRegistry } from './ItemRegistry.js';

export class ItemStack {
  constructor(itemId, count = 1) {
    this.itemId = itemId;
    this.count = count;
  }

  get maxStack() { return ItemRegistry.stackSize(this.itemId); }
  get isEmpty() { return this.count <= 0; }
  get displayName() { return ItemRegistry.displayName(this.itemId); }

  clone() { return new ItemStack(this.itemId, this.count); }

  canMergeWith(other) { return !!other && other.itemId === this.itemId; }

  /** Move as many items as possible from `other` into this stack; returns the number moved. */
  absorb(other) {
    if (!this.canMergeWith(other)) return 0;
    const space = this.maxStack - this.count;
    const moved = Math.min(space, other.count);
    this.count += moved;
    other.count -= moved;
    return moved;
  }

  /** Split off the upper half (rounded up) into a new stack. */
  splitHalf() {
    const take = Math.ceil(this.count / 2);
    this.count -= take;
    return new ItemStack(this.itemId, take);
  }

  take(n) {
    const take = Math.min(n, this.count);
    this.count -= take;
    return new ItemStack(this.itemId, take);
  }

  serialize() { return { id: this.itemId, n: this.count }; }
  /** Unknown ids (from older saves or removed items) load as an empty slot. */
  static deserialize(d) { return d && d.n > 0 && ItemRegistry.has(d.id) ? new ItemStack(d.id, d.n) : null; }
}
