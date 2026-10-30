// LootTables.js — structure chest loot (structures/loot.json): weighted item entries with count ranges and a number of
// rolls per chest. A chest's contents are rolled deterministically from the world seed and the chest position (see
// StructurePlacer), so every player of a world finds the same loot. Worker-safe.

import { ItemRegistry } from '../items/ItemRegistry.js';

export const CHEST_SLOTS = 36;

export class LootTables {
  /** @param {Record<string, {rolls: number|[number, number], entries: {item: string, weight?: number, count?: number|[number, number]}[]}>} json */
  constructor(json) {
    /** @type {Map<string, {rolls: [number, number], entries: {id: number, weight: number, count: [number, number]}[], total: number}>} */
    this.tables = new Map();
    for (const [name, t] of Object.entries(json || {})) {
      const rolls = Array.isArray(t.rolls) ? [t.rolls[0] | 0, t.rolls[1] | 0] : [t.rolls | 0, t.rolls | 0];
      const entries = [];
      for (const e of t.entries || []) {
        const id = ItemRegistry.idOf(e.item);
        if (!id) { console.warn(`Loot table ${name}: unknown item "${e.item}" skipped`); continue; }
        const count = Array.isArray(e.count) ? [Math.max(1, e.count[0] | 0), Math.max(1, e.count[1] | 0)] : [Math.max(1, e.count | 0 || 1), Math.max(1, e.count | 0 || 1)];
        entries.push({ id, weight: Math.max(0, +e.weight || 1), count });
      }
      this.tables.set(name, { rolls, entries, total: entries.reduce((s, e) => s + e.weight, 0) });
    }
  }

  has(name) { return this.tables.has(name); }

  /**
   * Roll a chest: `rolls` picks, each a weighted entry with a count in its range, dropped into random distinct slots.
   * @param {import('../utils/Random.js').Random} rng
   * @returns {Array<[number, number]|0>} serialized ChestStorage slots (36 entries)
   */
  roll(name, rng) {
    const slots = new Array(CHEST_SLOTS).fill(0);
    const t = this.tables.get(name);
    if (!t || !t.entries.length || t.total <= 0) return slots;
    const n = rng.nextIntRange(t.rolls[0], t.rolls[1]);
    for (let k = 0; k < n; k++) {
      let pick = rng.next() * t.total;
      let e = t.entries[t.entries.length - 1];
      for (const c of t.entries) { pick -= c.weight; if (pick < 0) { e = c; break; } }
      const count = rng.nextIntRange(e.count[0], e.count[1]);
      let slot = rng.nextInt(CHEST_SLOTS);
      for (let tries = 0; tries < CHEST_SLOTS && slots[slot] !== 0; tries++) slot = (slot + 1) % CHEST_SLOTS;
      if (slots[slot] === 0) slots[slot] = [e.id, count];
    }
    return slots;
  }
}
