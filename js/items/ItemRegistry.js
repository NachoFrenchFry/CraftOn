// ItemRegistry.js — every item: placeable blocks (item id === block id) plus the non-block items from
// ItemDefinitions.js (ids 256+). Pure data, worker-safe.

import { BLOCK_DEFINITIONS } from '../blocks/BlockDefinitions.js';
import { ITEM_DEFINITIONS } from './ItemDefinitions.js';
import { MAX_STACK } from '../config/Constants.js';

const items = new Map();
const idByName = new Map();

for (const def of BLOCK_DEFINITIONS) {
  if (!def.placeable) continue;
  items.set(def.id, {
    id: def.id,
    blockId: def.id,
    isBlock: true,
    name: def.name,
    displayName: def.displayName,
    texture: null,
    stackSize: def.stackSize || MAX_STACK,
    creativeOnly: !!def.creativeOnly,
    tool: null,
    armor: null,
    spawnEgg: null,
    food: null,
  });
}
for (const def of ITEM_DEFINITIONS) {
  items.set(def.id, {
    id: def.id,
    blockId: null,
    isBlock: false,
    name: def.name,
    displayName: def.displayName,
    texture: def.texture,
    stackSize: def.stackSize || MAX_STACK,
    creativeOnly: !!def.creativeOnly,
    tool: def.tool || null,
    armor: def.armor || null,
    spawnEgg: def.spawnEgg || null,
    food: def.food || null, // { heal } (Update #9 §8)
  });
}
for (const it of items.values()) idByName.set(it.name, it.id);

export const ItemRegistry = {
  get(id) { return items.get(id) || null; },
  has(id) { return items.has(id); },
  /** Item id for a block or item name, or -1. */
  idOf(name) { return idByName.has(name) ? idByName.get(name) : -1; },
  isBlock(id) { const it = items.get(id); return !!(it && it.isBlock); },
  /** Block id placed by this item, or null for non-block items. */
  blockOf(id) { const it = items.get(id); return it ? it.blockId : null; },
  displayName(id) { const it = items.get(id); return it ? it.displayName : 'Unknown'; },
  stackSize(id) { const it = items.get(id); return it ? it.stackSize : MAX_STACK; },
  /** Tool data ({ type, speed }) or null. */
  tool(id) { const it = items.get(id); return it ? it.tool : null; },
  /** Armor data ({ slot, material, points }) or null. */
  armor(id) { const it = items.get(id); return it ? it.armor : null; },
  /** { heal } for food, else null. */
  food(id) { const it = items.get(id); return it && it.food ? it.food : null; },
  /** Mob type spawned by a spawn egg, or null. */
  spawnEgg(id) { const it = items.get(id); return it ? it.spawnEgg : null; },
  /** Every item, including creative-only ones. */
  all() { return [...items.values()]; },
  /** Items obtainable/visible in survival. */
  survival() { return [...items.values()].filter((i) => !i.creativeOnly); },
};
