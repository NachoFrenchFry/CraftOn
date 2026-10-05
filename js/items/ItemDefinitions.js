// ItemDefinitions.js — non-block items (ids 256+ so they never collide with block ids). Pure data.
// Every placeable block is also an item with id === block id (see ItemRegistry.js).

export const ITEM_ID_BASE = 256;

export const ItemIds = Object.freeze({
  COAL: 256,
  IRON_INGOT: 257,
  GOLD_INGOT: 258,
  DIAMOND: 259,
  WOODEN_PICKAXE: 260,
  IRON_PICKAXE: 261,
  DIAMOND_PICKAXE: 262,
  STONE_PICKAXE: 263,
  WOODEN_SWORD: 264,
  STONE_SWORD: 265,
  IRON_SWORD: 266,
  DIAMOND_SWORD: 267,
  BUCKET: 268,
  WATER_BUCKET: 269,
  RAW_BEEF: 270,
  RAW_PORKCHOP: 271,
  RAW_MUTTON: 272,
  WOODEN_AXE: 273,
  STONE_AXE: 274,
  IRON_AXE: 275,
  DIAMOND_AXE: 276,
  WOODEN_HELMET: 277, WOODEN_CHESTPLATE: 278, WOODEN_GAUNTLETS: 279, WOODEN_LEGGINGS: 280, WOODEN_BOOTS: 281,
  IRON_HELMET: 282, IRON_CHESTPLATE: 283, IRON_GAUNTLETS: 284, IRON_LEGGINGS: 285, IRON_BOOTS: 286,
  DIAMOND_HELMET: 287, DIAMOND_CHESTPLATE: 288, DIAMOND_GAUNTLETS: 289, DIAMOND_LEGGINGS: 290, DIAMOND_BOOTS: 291,
  COW_SPAWN_EGG: 292, PIG_SPAWN_EGG: 293, SHEEP_SPAWN_EGG: 294,
});

/** Armor slots in display order (the inventory's armor row). */
export const ARMOR_SLOTS = Object.freeze(['helmet', 'chestplate', 'gauntlets', 'leggings', 'boots']);
/** Armor points per material and piece (shown as "+N Armor"; the player has no health yet, so they are stored only). */
export const ARMOR_POINTS = Object.freeze({
  wood: { helmet: 1, chestplate: 3, gauntlets: 1, leggings: 2, boots: 1 },
  iron: { helmet: 2, chestplate: 6, gauntlets: 2, leggings: 5, boots: 2 },
  diamond: { helmet: 3, chestplate: 8, gauntlets: 3, leggings: 6, boots: 3 },
});
const PIECE_NAMES = { helmet: 'Helmet', chestplate: 'Chestplate', gauntlets: 'Gauntlets', leggings: 'Leggings', boots: 'Boots' };
const MATERIAL_NAMES = { wood: 'Wooden', iron: 'Iron', diamond: 'Diamond' };
const MATERIAL_PREFIX = { wood: 'wooden', iron: 'iron', diamond: 'diamond' };
function armorDefs() {
  const out = [];
  let id = ItemIds.WOODEN_HELMET;
  for (const material of ['wood', 'iron', 'diamond']) for (const slot of ARMOR_SLOTS) {
    const name = `${MATERIAL_PREFIX[material]}_${slot}`;
    out.push({ id: id++, name, displayName: `${MATERIAL_NAMES[material]} ${PIECE_NAMES[slot]}`, texture: name, stackSize: 1, placeable: false,
      armor: { slot, material, points: ARMOR_POINTS[material][slot] } });
  }
  return out;
}

/** Mining speed multipliers per pickaxe (break time is divided by the multiplier on stone-type blocks). */
export const PICKAXE_SPEED = Object.freeze({ wooden: 2, stone: 3, iron: 4, diamond: 6 });
/** Mining speed multipliers per axe (on wood-type blocks). */
export const AXE_SPEED = Object.freeze({ wooden: 2, stone: 3, iron: 4, diamond: 6 });

/**
 * Fields: id, name, displayName, texture (16×16 icon / held sprite), stackSize, placeable (always false),
 * tool: { type: 'pickaxe' | 'axe' | 'sword', speed (pickaxes / axes), damage } for tools and weapons;
 * armor: { slot, material, points } for armor; spawnEgg: mob type (creative-only, never dropped or crafted).
 */
export const ITEM_DEFINITIONS = Object.freeze([
  { id: ItemIds.COAL, name: 'coal', displayName: 'Coal', texture: 'coal', stackSize: 64, placeable: false },
  { id: ItemIds.IRON_INGOT, name: 'iron_ingot', displayName: 'Iron Ingot', texture: 'iron_ingot', stackSize: 64, placeable: false },
  { id: ItemIds.GOLD_INGOT, name: 'gold_ingot', displayName: 'Gold Ingot', texture: 'gold_ingot', stackSize: 64, placeable: false },
  { id: ItemIds.DIAMOND, name: 'diamond', displayName: 'Diamond', texture: 'diamond', stackSize: 64, placeable: false },
  { id: ItemIds.WOODEN_PICKAXE, name: 'wooden_pickaxe', displayName: 'Wooden Pickaxe', texture: 'wooden_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.wooden, damage: 2 } },
  { id: ItemIds.STONE_PICKAXE, name: 'stone_pickaxe', displayName: 'Stone Pickaxe', texture: 'stone_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.stone, damage: 3 } },
  { id: ItemIds.IRON_PICKAXE, name: 'iron_pickaxe', displayName: 'Iron Pickaxe', texture: 'iron_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.iron, damage: 4 } },
  { id: ItemIds.DIAMOND_PICKAXE, name: 'diamond_pickaxe', displayName: 'Diamond Pickaxe', texture: 'diamond_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.diamond, damage: 5 } },
  { id: ItemIds.WOODEN_SWORD, name: 'wooden_sword', displayName: 'Wooden Sword', texture: 'wooden_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: 4 } },
  { id: ItemIds.STONE_SWORD, name: 'stone_sword', displayName: 'Stone Sword', texture: 'stone_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: 5 } },
  { id: ItemIds.IRON_SWORD, name: 'iron_sword', displayName: 'Iron Sword', texture: 'iron_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: 6 } },
  { id: ItemIds.DIAMOND_SWORD, name: 'diamond_sword', displayName: 'Diamond Sword', texture: 'diamond_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: 7 } },
  { id: ItemIds.BUCKET, name: 'bucket', displayName: 'Bucket', texture: 'bucket', stackSize: 16, placeable: false },
  { id: ItemIds.WATER_BUCKET, name: 'water_bucket', displayName: 'Water Bucket', texture: 'water_bucket', stackSize: 1, placeable: false },
  { id: ItemIds.RAW_BEEF, name: 'raw_beef', displayName: 'Raw Beef', texture: 'raw_beef', stackSize: 64, placeable: false },
  { id: ItemIds.RAW_PORKCHOP, name: 'raw_porkchop', displayName: 'Raw Porkchop', texture: 'raw_porkchop', stackSize: 64, placeable: false },
  { id: ItemIds.RAW_MUTTON, name: 'raw_mutton', displayName: 'Raw Mutton', texture: 'raw_mutton', stackSize: 64, placeable: false },
  // Update #4: axes (wood-type blocks)
  { id: ItemIds.WOODEN_AXE, name: 'wooden_axe', displayName: 'Wooden Axe', texture: 'wooden_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.wooden, damage: 3 } },
  { id: ItemIds.STONE_AXE, name: 'stone_axe', displayName: 'Stone Axe', texture: 'stone_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.stone, damage: 4 } },
  { id: ItemIds.IRON_AXE, name: 'iron_axe', displayName: 'Iron Axe', texture: 'iron_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.iron, damage: 5 } },
  { id: ItemIds.DIAMOND_AXE, name: 'diamond_axe', displayName: 'Diamond Axe', texture: 'diamond_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.diamond, damage: 6 } },
  // Update #5: armor (15 pieces) and creative-only spawn eggs
  ...armorDefs(),
  { id: ItemIds.COW_SPAWN_EGG, name: 'cow_spawn_egg', displayName: 'Cow Spawn Egg', texture: 'cow_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'cow' },
  { id: ItemIds.PIG_SPAWN_EGG, name: 'pig_spawn_egg', displayName: 'Pig Spawn Egg', texture: 'pig_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'pig' },
  { id: ItemIds.SHEEP_SPAWN_EGG, name: 'sheep_spawn_egg', displayName: 'Sheep Spawn Egg', texture: 'sheep_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'sheep' },
]);
