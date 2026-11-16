// LootTables.js — structure chest loot (structures/loot.json): weighted item entries with count ranges and a number of
// rolls per chest, plus (Nov 15 2026) an optional `always` list — stacks every chest of the table holds, placed first in
// random free slots, the random rolls after them. A chest's contents are rolled deterministically from the world seed and
// the chest position (see StructurePlacer), so every player of a world finds the same loot. Worker-safe.

import { ItemRegistry } from '../items/ItemRegistry.js';

export const CHEST_SLOTS = 36;

export class LootTables {
  /** @param {Record<string, {rolls: number|[number, number], always?: {item: string, count?: number|[number, number]}[], entries: {item: string, weight?: number, count?: number|[number, number]}[]}>} json */
  constructor(json) {
    /** @type {Map<string, {rolls: [number, number], always: {id: number, count: [number, number]}[], entries: {id: number, weight: number, count: [number, number]}[], total: number}>} */
    this.tables = new Map();
    const countOf = (c) => Array.isArray(c) ? [Math.max(1, c[0] | 0), Math.max(1, c[1] | 0)] : [Math.max(1, c | 0 || 1), Math.max(1, c | 0 || 1)];
    for (const [name, t] of Object.entries(json || {})) {
      const rolls = Array.isArray(t.rolls) ? [t.rolls[0] | 0, t.rolls[1] | 0] : [t.rolls | 0, t.rolls | 0];
      const entries = [], always = [];
      for (const e of t.always || []) {
        const id = ItemRegistry.idOf(e.item);
        if (!id) { console.warn(`Loot table ${name}: unknown item "${e.item}" skipped`); continue; }
        always.push({ id, count: countOf(e.count) });
      }
      for (const e of t.entries || []) {
        const id = ItemRegistry.idOf(e.item);
        if (!id) { console.warn(`Loot table ${name}: unknown item "${e.item}" skipped`); continue; }
        entries.push({ id, weight: Math.max(0, +e.weight || 1), count: countOf(e.count) });
      }
      this.tables.set(name, { rolls, always, entries, total: entries.reduce((s, e) => s + e.weight, 0) });
    }
  }

  has(name) { return this.tables.has(name); }

  /**
   * Roll a chest: the table's `always` stacks first (a count in each one's range, random free slots), then `rolls` picks,
   * each a weighted entry with a count in its range, dropped into random distinct slots.
   * @param {import('../utils/Random.js').Random} rng
   * @returns {Array<[number, number]|0>} serialized ChestStorage slots (36 entries)
   */
  roll(name, rng) {
    const slots = new Array(CHEST_SLOTS).fill(0);
    const t = this.tables.get(name);
    if (!t) return slots;
    const drop = (id, count) => {
      let slot = rng.nextInt(CHEST_SLOTS);
      for (let tries = 0; tries < CHEST_SLOTS && slots[slot] !== 0; tries++) slot = (slot + 1) % CHEST_SLOTS;
      if (slots[slot] === 0) slots[slot] = [id, count];
    };
    for (const a of t.always) drop(a.id, rng.nextIntRange(a.count[0], a.count[1]));
    if (!t.entries.length || t.total <= 0) return slots;
    const n = rng.nextIntRange(t.rolls[0], t.rolls[1]);
    for (let k = 0; k < n; k++) {
      let pick = rng.next() * t.total;
      let e = t.entries[t.entries.length - 1];
      for (const c of t.entries) { pick -= c.weight; if (pick < 0) { e = c; break; } }
      drop(e.id, rng.nextIntRange(e.count[0], e.count[1]));
    }
    return slots;
  }
}
