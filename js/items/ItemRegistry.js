// ItemRegistry.js — every item: placeable blocks (item id === block id) plus the non-block items from
// ItemDefinitions.js (ids 256+). Pure data, worker-safe.

import { BLOCK_DEFINITIONS } from '../blocks/BlockDefinitions.js';
import { ITEM_DEFINITIONS, HAND_KNOCKBACK } from './ItemDefinitions.js';
import { MAX_STACK } from '../config/Constants.js';
import { BlockIds } from '../blocks/BlockIds.js';

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
    knockback: HAND_KNOCKBACK,
    bow: false,
    def,
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
    food: def.food || null, // { heal }
    knockback: def.knockback || HAND_KNOCKBACK,
    bow: !!def.bow,
    glider: !!def.glider,
    rocket: !!def.rocket,
    def,
  });
}
for (const it of items.values()) idByName.set(it.name, it.id);

// ---- Catalog order: by category, then tier (wood → stone → gold → iron → diamond), then data order ----
const TIER_ORDER = { wooden: 0, wood: 0, stone: 1, golden: 2, gold: 2, iron: 3, diamond: 4 };
const TOOL_ORDER = { pickaxe: 0, axe: 1, sword: 2 };
const PIECE_ORDER = { helmet: 0, chestplate: 1, gauntlets: 2, leggings: 3, boots: 4 };
const tierOf = (name) => { const t = name.split('_')[0]; return TIER_ORDER[t] !== undefined ? TIER_ORDER[t] : 9; };
/** Blocks by kind: building, natural, ores + storage, plants, functional. */
const NATURAL_BLOCKS = new Set(['grass_block', 'dirt', 'sand', 'gravel', 'clay', 'snow', 'snowy_grass', 'ice', 'log', 'leaves', 'bedrock', 'water', 'lava', 'stone', 'cobblestone', 'sandstone', 'mossy_cobblestone', 'obsidian']);
const FUNCTIONAL_BLOCKS = new Set(['crafting_table', 'furnace', 'chest', 'torch', 'explosives']);
const MATERIAL_ITEMS = new Set(['string', 'coal', 'iron_ingot', 'gold_ingot', 'diamond']);
const MATERIAL_ORDER = ['string', 'coal', 'iron_ingot', 'gold_ingot', 'diamond'];
/**
 * [category, tier, sub, dataIndex]: the Creative catalog, the search results and the Survival recipe tie-breaker all
 * follow it, so gold always comes before iron and nothing depends on where an item was appended to the definitions.
 */
function rankOf(it, index) {
  const name = it.name;
  if (it.isBlock) {
    const blockDef = it.def;
    if (name.endsWith('_ore') || name.endsWith('_block') && !NATURAL_BLOCKS.has(name) && name !== 'grass_block') return [2, name.endsWith('_ore') ? 0 : 1, 0, index];
    if (blockDef.renderType === 'cross' || name === 'cactus' || name === 'dead_bush') return [3, 0, 0, index];
    if (FUNCTIONAL_BLOCKS.has(name)) return [4, 0, 0, index];
    if (NATURAL_BLOCKS.has(name)) return [1, 0, 0, index];
    return [0, 0, 0, index];
  }
  if (it.tool) return [5, 0, (TOOL_ORDER[it.tool.type] ?? 5) * 10 + tierOf(name), index];
  if (it.bow || name === 'arrow') return [5, 1, it.bow ? 0 : 1, index];
  if (name === 'stick') return [5, 2, 0, index];
  if (it.glider || it.rocket) return [5, 3, it.glider ? 0 : 1, index];
  if (it.armor) return [6, 0, TIER_ORDER[it.armor.material] * 10 + (PIECE_ORDER[it.armor.slot] ?? 9), index];
  if (it.food) return [7, name.startsWith('raw_') ? 0 : 1, 0, index];
  if (MATERIAL_ITEMS.has(name)) return [8, 0, MATERIAL_ORDER.indexOf(name), index];
  if (name.endsWith('bucket')) return [9, 0, name === 'bucket' ? 0 : name === 'water_bucket' ? 1 : 2, index];
  if (it.spawnEgg) return [10, 0, 0, index];
  return [8, 5, 0, index];
}
const ranks = new Map();
{ let i = 0; for (const it of items.values()) ranks.set(it.id, rankOf(it, i++)); }
const compareRank = (a, b) => { for (let k = 0; k < 4; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
const CATALOG = [...items.values()].sort((a, b) => compareRank(ranks.get(a.id), ranks.get(b.id)));

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
  /** Knockback points when hitting with the item (the empty hand has HAND_KNOCKBACK). */
  knockback(id) { const it = items.get(id); return it ? it.knockback : HAND_KNOCKBACK; },
  isBow(id) { const it = items.get(id); return !!(it && it.bow); },
  isGlider(id) { const it = items.get(id); return !!(it && it.glider); },
  isRocket(id) { const it = items.get(id); return !!(it && it.rocket); },
  /** Every item, including creative-only ones, in definition order. */
  all() { return [...items.values()]; },
  /** Every item in catalog order: building, natural, ores / storage, plants, functional blocks, tools (wood → stone → gold → iron → diamond, then bow, arrows, stick), armor, food, materials, buckets, spawn eggs. */
  catalog() { return CATALOG.slice(); },
  /** Sort key of an item in that order (compare with compareCatalog). */
  catalogRank(id) { return ranks.get(id) || [99, 0, 0, 0]; },
  compareCatalog(a, b) { return compareRank(ranks.get(a) || [99, 0, 0, 0], ranks.get(b) || [99, 0, 0, 0]); },
  /** The explosives block id (the item that primes an explosive when placed). */
  get EXPLOSIVES() { return BlockIds.EXPLOSIVES; },
  /** Items obtainable/visible in survival. */
  survival() { return [...items.values()].filter((i) => !i.creativeOnly); },
};
