// CraftingSystem.js — resolves recipes to item ids, counts what the inventory can afford and performs
// instant crafts (bloxd.io style, no grid). Materials come from the whole inventory; results go back into
// it, overflowing to a drop callback when full. Pure logic (no DOM), used by CraftingPanel.

import { RECIPES } from './Recipes.js';
import { ItemRegistry } from '../items/ItemRegistry.js';

/** Recipes with names resolved to ids: { id, station list, result: {itemId, count}, inputs: [{itemId, count}] }. */
export const RESOLVED_RECIPES = RECIPES.map((r) => {
  const resolve = (name) => {
    const id = ItemRegistry.idOf(name);
    if (id < 0) throw new Error(`Recipe ${r.id}: unknown item "${name}"`);
    return id;
  };
  return {
    id: r.id,
    stations: r.stations,
    result: { itemId: resolve(r.result.item), count: r.result.count },
    inputs: r.inputs.map((i) => ({ itemId: resolve(i.item), count: i.count })),
    byproducts: (r.byproducts || []).map((i) => ({ itemId: resolve(i.item), count: i.count })),
  };
});

export class CraftingSystem {
  /**
   * @param {import('../items/Inventory.js').Inventory} inventory
   * @param {import('../core/EventBus.js').EventBus} events
   * @param {(itemId:number, count:number)=>void} dropOverflow called with results that did not fit
   */
  constructor(inventory, events, dropOverflow) {
    this.inventory = inventory;
    this.events = events;
    this.dropOverflow = dropOverflow;
  }

  /** Recipes available at a station, in data order. */
  recipesFor(station) {
    return RESOLVED_RECIPES.filter((r) => r.stations.includes(station));
  }

  /** How many times the recipe can be made with the current inventory contents. */
  craftableCount(recipe) {
    let n = Infinity;
    for (const input of recipe.inputs) n = Math.min(n, Math.floor(this.inventory.countOf(input.itemId) / input.count));
    return n === Infinity ? 0 : n;
  }

  /** Remove `count` of an item from the inventory, taking from later slots first. Returns the amount removed. */
  _consume(itemId, count) {
    let left = count;
    const slots = this.inventory.slots;
    for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
      const s = slots[i];
      if (!s || s.itemId !== itemId) continue;
      const take = Math.min(left, s.count);
      s.count -= take;
      left -= take;
      if (s.count <= 0) slots[i] = null;
    }
    return count - left;
  }

  /**
   * Craft a recipe `times` times (capped by what is affordable). Returns the number actually crafted.
   * @param {'once'|'max'|number} times
   */
  craft(recipe, times = 'once') {
    const affordable = this.craftableCount(recipe);
    const n = Math.min(affordable, times === 'max' ? Infinity : times === 'once' ? 1 : times);
    if (n <= 0) return 0;
    for (const input of recipe.inputs) this._consume(input.itemId, input.count * n);
    const total = recipe.result.count * n;
    const left = this.inventory.addItem(recipe.result.itemId, total);
    if (left > 0 && this.dropOverflow) this.dropOverflow(recipe.result.itemId, left);
    for (const b of recipe.byproducts || []) { const extra = this.inventory.addItem(b.itemId, b.count * n); if (extra > 0 && this.dropOverflow) this.dropOverflow(b.itemId, extra); }
    this.inventory.changed();
    if (this.events) this.events.emit('craft:done', recipe, n);
    return n;
  }
}
