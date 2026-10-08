// Inventory.js — the player's container: 9 hotbar slots (0–8), 36 storage slots (9–44, a 6×6 grid) and
// 5 armor slots (45–49: helmet, chestplate, gauntlets, leggings, boots). Minecraft-style add / merge /
// swap / split logic. Emits 'inventory:changed' and 'inventory:selected'. Saves with 27-slot storage
// (before Update #5) load into the first 27 storage slots because slot indices are unchanged.

import { ItemStack } from './ItemStack.js';
import { ItemRegistry } from './ItemRegistry.js';
import { ARMOR_SLOTS } from './ItemDefinitions.js';

export const HOTBAR_SIZE = 9;
export const MAIN_SIZE = 36;
/** Hotbar + storage: the slots items are added to and counted in. */
export const INVENTORY_SIZE = HOTBAR_SIZE + MAIN_SIZE;
export const ARMOR_START = INVENTORY_SIZE;
export const TOTAL_SLOTS = INVENTORY_SIZE + ARMOR_SLOTS.length;
export { ARMOR_SLOTS };

export class Inventory {
  /** @param {import('../core/EventBus.js').EventBus} events */
  constructor(events) {
    this.events = events;
    /** @type {(ItemStack|null)[]} */
    this.slots = new Array(TOTAL_SLOTS).fill(null);
    this.selectedIndex = 0;
  }

  clear() {
    this.slots.fill(null);
    this.selectedIndex = 0;
    this.changed();
  }

  changed() { this.events.emit('inventory:changed', this); }

  get(i) { return this.slots[i]; }

  /** Armor slots only accept their own piece; returns false when the stack was refused. */
  set(i, stack) {
    const next = stack && stack.count > 0 ? stack : null;
    if (next && !this.acceptsAt(i, next.itemId)) return false;
    this.slots[i] = next;
    this.changed();
    return true;
  }

  static isArmorIndex(i) { return i >= ARMOR_START && i < TOTAL_SLOTS; }
  /** Armor slot index for an armor item, or -1 for anything else. */
  static armorIndexFor(itemId) {
    const a = ItemRegistry.armor(itemId);
    return a ? ARMOR_START + ARMOR_SLOTS.indexOf(a.slot) : -1;
  }
  /** Can `itemId` sit in slot `i`? Storage takes anything; an armor slot only its own piece type. */
  acceptsAt(i, itemId) {
    if (!Inventory.isArmorIndex(i)) return true;
    return Inventory.armorIndexFor(itemId) === i;
  }

  getSelected() { return this.slots[this.selectedIndex]; }

  setSelectedIndex(i) {
    const next = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.events.emit('inventory:selected', next);
  }

  /** Add items to hotbar + storage; fills existing stacks first (hotbar first), then empty slots. Returns the leftover. */
  addItem(itemId, count) {
    let remaining = count;
    const probe = new ItemStack(itemId, remaining);
    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.itemId === itemId && s.count < s.maxStack) {
        probe.count = remaining;
        s.absorb(probe);
        remaining = probe.count;
      }
    }
    for (let i = 0; i < INVENTORY_SIZE && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const take = Math.min(remaining, probe.maxStack);
        this.slots[i] = new ItemStack(itemId, take);
        remaining -= take;
      }
    }
    if (remaining !== count) this.changed();
    return remaining;
  }

  /** How many of `count` items of a type would fit (existing stacks first, then empty slots). */
  canAccept(itemId, count) {
    let room = 0;
    const max = ItemRegistry.stackSize(itemId);
    for (let i = 0; i < INVENTORY_SIZE && room < count; i++) {
      const s = this.slots[i];
      if (s === null) room += max;
      else if (s.itemId === itemId) room += Math.max(0, s.maxStack - s.count);
    }
    return Math.min(count, room);
  }

  /** Remove n items from a slot; returns the removed stack (or null). */
  removeFromSlot(i, n = 1) {
    const s = this.slots[i];
    if (!s) return null;
    const out = s.take(n);
    if (s.count <= 0) this.slots[i] = null;
    this.changed();
    return out;
  }

  /** Swap two slots (refused when an armor slot would receive a foreign item). */
  swap(a, b) {
    const sa = this.slots[a], sb = this.slots[b];
    if ((sb && !this.acceptsAt(a, sb.itemId)) || (sa && !this.acceptsAt(b, sa.itemId))) return false;
    this.slots[a] = sb;
    this.slots[b] = sa;
    this.changed();
    return true;
  }

  /** Split half of a slot into a new stack (returned). */
  split(i) {
    const s = this.slots[i];
    if (!s) return null;
    const half = s.splitHalf();
    if (s.count <= 0) this.slots[i] = null;
    this.changed();
    return half;
  }

  /**
   * Equip the armor piece in slot `i` straight into its armor slot (Update #8 right-click). A piece already
   * worn there swaps back into slot `i`. Returns the armor slot index, or -1 when the slot holds no armor.
   */
  equipFromSlot(i) {
    const s = this.slots[i];
    if (!s) return -1;
    const a = Inventory.armorIndexFor(s.itemId);
    if (a < 0) return -1;
    const worn = this.slots[a];
    this.slots[a] = s;
    this.slots[i] = worn || null;
    this.changed();
    return a;
  }

  /** Index of the first hotbar slot holding an item, or -1. */
  findInHotbar(itemId) {
    for (let i = 0; i < HOTBAR_SIZE; i++) if (this.slots[i] && this.slots[i].itemId === itemId) return i;
    return -1;
  }

  /** Count all items of a type in the hotbar + storage (worn armor is not counted). */
  countOf(itemId) {
    let n = 0;
    for (let i = 0; i < INVENTORY_SIZE; i++) { const s = this.slots[i]; if (s && s.itemId === itemId) n += s.count; }
    return n;
  }

  isFull() { for (let i = 0; i < INVENTORY_SIZE; i++) if (this.slots[i] === null) return false; return true; }

  /** Worn armor: { helmet: 'iron' | null, ... } by material. */
  armorMaterials() {
    const out = {};
    ARMOR_SLOTS.forEach((slot, k) => { const s = this.slots[ARMOR_START + k]; const a = s ? ItemRegistry.armor(s.itemId) : null; out[slot] = a ? a.material : null; });
    return out;
  }

  /** Armor points of one worn slot ('boots' count double against falls, Update #9 §8). */
  armorPointsFor(slot) {
    const k = ARMOR_SLOTS.indexOf(slot);
    const s = k >= 0 ? this.slots[ARMOR_START + k] : null;
    const a = s ? ItemRegistry.armor(s.itemId) : null;
    return a ? a.points : 0;
  }

  /** Total armor points of every worn piece. */
  armorPoints() {
    let n = 0;
    for (let k = 0; k < ARMOR_SLOTS.length; k++) { const s = this.slots[ARMOR_START + k]; const a = s ? ItemRegistry.armor(s.itemId) : null; if (a) n += a.points; }
    return n;
  }

  serialize() {
    return {
      selected: this.selectedIndex,
      slots: this.slots.slice(0, INVENTORY_SIZE).map((s) => (s ? s.serialize() : null)),
      armor: this.slots.slice(ARMOR_START).map((s) => (s ? s.serialize() : null)),
    };
  }

  deserialize(d) {
    if (!d) return;
    this.slots = new Array(TOTAL_SLOTS).fill(null);
    if (Array.isArray(d.slots)) d.slots.forEach((s, i) => { if (i < INVENTORY_SIZE) this.slots[i] = ItemStack.deserialize(s); });
    if (Array.isArray(d.armor)) d.armor.forEach((s, k) => {
      const stack = ItemStack.deserialize(s);
      if (stack && this.acceptsAt(ARMOR_START + k, stack.itemId)) this.slots[ARMOR_START + k] = stack;
    });
    this.selectedIndex = Math.min(HOTBAR_SIZE - 1, Math.max(0, d.selected | 0));
    this.changed();
    this.events.emit('inventory:selected', this.selectedIndex);
  }
}
