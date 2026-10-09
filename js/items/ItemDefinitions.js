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
  COOKED_BEEF: 295, COOKED_PORKCHOP: 296, COOKED_MUTTON: 297, // Update #9 §8: smelted from the raw meats
  // Update #11
  STICK: 298,
  LAVA_BUCKET: 299,
  GOLDEN_PICKAXE: 300, GOLDEN_AXE: 301, GOLDEN_SWORD: 302,
  GOLDEN_HELMET: 303, GOLDEN_CHESTPLATE: 304, GOLDEN_GAUNTLETS: 305, GOLDEN_LEGGINGS: 306, GOLDEN_BOOTS: 307,
});

/** Armor slots in display order (the inventory's armor row). */
export const ARMOR_SLOTS = Object.freeze(['helmet', 'chestplate', 'gauntlets', 'leggings', 'boots']);
/** Armor points per material and piece (shown as "+N Armor"; the player has no health yet, so they are stored only). */
export const ARMOR_POINTS = Object.freeze({
  wood: { helmet: 1, chestplate: 3, gauntlets: 1, leggings: 2, boots: 1 },     // 8
  gold: { helmet: 2, chestplate: 4, gauntlets: 1, leggings: 3, boots: 1 },     // 11 (Update #11: between wood and iron)
  iron: { helmet: 2, chestplate: 6, gauntlets: 2, leggings: 5, boots: 2 },     // 17
  diamond: { helmet: 3, chestplate: 8, gauntlets: 3, leggings: 6, boots: 3 },  // 23
});
const PIECE_NAMES = { helmet: 'Helmet', chestplate: 'Chestplate', gauntlets: 'Gauntlets', leggings: 'Leggings', boots: 'Boots' };
const MATERIAL_NAMES = { wood: 'Wooden', gold: 'Golden', iron: 'Iron', diamond: 'Diamond' };
const MATERIAL_PREFIX = { wood: 'wooden', gold: 'golden', iron: 'iron', diamond: 'diamond' };
const ARMOR_FIRST_ID = { wood: ItemIds.WOODEN_HELMET, iron: ItemIds.IRON_HELMET, diamond: ItemIds.DIAMOND_HELMET, gold: ItemIds.GOLDEN_HELMET };
function armorDefs() {
  const out = [];
  for (const material of ['wood', 'gold', 'iron', 'diamond']) {
    let id = ARMOR_FIRST_ID[material];
    for (const slot of ARMOR_SLOTS) {
      const name = `${MATERIAL_PREFIX[material]}_${slot}`;
      out.push({ id: id++, name, displayName: `${MATERIAL_NAMES[material]} ${PIECE_NAMES[slot]}`, texture: name, stackSize: 1, placeable: false,
        armor: { slot, material, points: ARMOR_POINTS[material][slot] } });
    }
  }
  return out;
}

/**
 * Tier table (Update #11): mining speed (pickaxe on stone-type, axe on wood-type), pickaxe / axe / sword damage.
 *   hand ×1 1/–/–  ·  wood ×4 2/3/4  ·  stone ×6 3/4/5  ·  gold ×8 4/5/6  ·  iron ×10 5/6/7  ·  diamond ×14 6/7/8
 * Stone by hand takes 6 s; with pickaxes 1.5 / 1.0 / 0.75 / 0.6 / ≈0.43 s.
 */
export const PICKAXE_SPEED = Object.freeze({ wooden: 4, stone: 6, golden: 8, iron: 10, diamond: 14 });
export const AXE_SPEED = Object.freeze({ wooden: 4, stone: 6, golden: 8, iron: 10, diamond: 14 });
export const TOOL_DAMAGE = Object.freeze({
  pickaxe: { wooden: 2, stone: 3, golden: 4, iron: 5, diamond: 6 },
  axe: { wooden: 3, stone: 4, golden: 5, iron: 6, diamond: 7 },
  sword: { wooden: 4, stone: 5, golden: 6, iron: 7, diamond: 8 },
});

/**
 * Fields: id, name, displayName, texture (16×16 icon / held sprite), stackSize, placeable (always false),
 * tool: { type: 'pickaxe' | 'axe' | 'sword', speed (pickaxes / axes), damage } for tools and weapons;
 * armor: { slot, material, points } for armor; spawnEgg: mob type (creative-only, never dropped or crafted);
 * food: { heal } for things you can eat (hold right click 1.6 s, Update #9 §8).
 */
export const ITEM_DEFINITIONS = Object.freeze([
  { id: ItemIds.COAL, name: 'coal', displayName: 'Coal', texture: 'coal', stackSize: 64, placeable: false },
  { id: ItemIds.IRON_INGOT, name: 'iron_ingot', displayName: 'Iron Ingot', texture: 'iron_ingot', stackSize: 64, placeable: false },
  { id: ItemIds.GOLD_INGOT, name: 'gold_ingot', displayName: 'Gold Ingot', texture: 'gold_ingot', stackSize: 64, placeable: false },
  { id: ItemIds.DIAMOND, name: 'diamond', displayName: 'Diamond', texture: 'diamond', stackSize: 64, placeable: false },
  { id: ItemIds.WOODEN_PICKAXE, name: 'wooden_pickaxe', displayName: 'Wooden Pickaxe', texture: 'wooden_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.wooden, damage: TOOL_DAMAGE.pickaxe.wooden } },
  { id: ItemIds.STONE_PICKAXE, name: 'stone_pickaxe', displayName: 'Stone Pickaxe', texture: 'stone_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.stone, damage: TOOL_DAMAGE.pickaxe.stone } },
  { id: ItemIds.IRON_PICKAXE, name: 'iron_pickaxe', displayName: 'Iron Pickaxe', texture: 'iron_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.iron, damage: TOOL_DAMAGE.pickaxe.iron } },
  { id: ItemIds.DIAMOND_PICKAXE, name: 'diamond_pickaxe', displayName: 'Diamond Pickaxe', texture: 'diamond_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.diamond, damage: TOOL_DAMAGE.pickaxe.diamond } },
  { id: ItemIds.GOLDEN_PICKAXE, name: 'golden_pickaxe', displayName: 'Golden Pickaxe', texture: 'golden_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.golden, damage: TOOL_DAMAGE.pickaxe.golden } },
  { id: ItemIds.WOODEN_SWORD, name: 'wooden_sword', displayName: 'Wooden Sword', texture: 'wooden_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.wooden } },
  { id: ItemIds.STONE_SWORD, name: 'stone_sword', displayName: 'Stone Sword', texture: 'stone_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.stone } },
  { id: ItemIds.IRON_SWORD, name: 'iron_sword', displayName: 'Iron Sword', texture: 'iron_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.iron } },
  { id: ItemIds.DIAMOND_SWORD, name: 'diamond_sword', displayName: 'Diamond Sword', texture: 'diamond_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.diamond } },
  { id: ItemIds.GOLDEN_SWORD, name: 'golden_sword', displayName: 'Golden Sword', texture: 'golden_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.golden } },
  { id: ItemIds.BUCKET, name: 'bucket', displayName: 'Bucket', texture: 'bucket', stackSize: 16, placeable: false },
  { id: ItemIds.WATER_BUCKET, name: 'water_bucket', displayName: 'Water Bucket', texture: 'water_bucket', stackSize: 1, placeable: false },
  { id: ItemIds.LAVA_BUCKET, name: 'lava_bucket', displayName: 'Lava Bucket', texture: 'lava_bucket', stackSize: 1, placeable: false },
  { id: ItemIds.STICK, name: 'stick', displayName: 'Stick', texture: 'stick', stackSize: 64, placeable: false },
  { id: ItemIds.RAW_BEEF, name: 'raw_beef', displayName: 'Raw Beef', texture: 'raw_beef', stackSize: 64, placeable: false, food: { heal: 12 } },
  { id: ItemIds.RAW_PORKCHOP, name: 'raw_porkchop', displayName: 'Raw Porkchop', texture: 'raw_porkchop', stackSize: 64, placeable: false, food: { heal: 12 } },
  { id: ItemIds.RAW_MUTTON, name: 'raw_mutton', displayName: 'Raw Mutton', texture: 'raw_mutton', stackSize: 64, placeable: false, food: { heal: 10 } },
  { id: ItemIds.COOKED_BEEF, name: 'cooked_beef', displayName: 'Cooked Beef', texture: 'cooked_beef', stackSize: 64, placeable: false, food: { heal: 30 } },
  { id: ItemIds.COOKED_PORKCHOP, name: 'cooked_porkchop', displayName: 'Cooked Porkchop', texture: 'cooked_porkchop', stackSize: 64, placeable: false, food: { heal: 30 } },
  { id: ItemIds.COOKED_MUTTON, name: 'cooked_mutton', displayName: 'Cooked Mutton', texture: 'cooked_mutton', stackSize: 64, placeable: false, food: { heal: 25 } },
  // Update #4: axes (wood-type blocks)
  { id: ItemIds.WOODEN_AXE, name: 'wooden_axe', displayName: 'Wooden Axe', texture: 'wooden_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.wooden, damage: TOOL_DAMAGE.axe.wooden } },
  { id: ItemIds.STONE_AXE, name: 'stone_axe', displayName: 'Stone Axe', texture: 'stone_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.stone, damage: TOOL_DAMAGE.axe.stone } },
  { id: ItemIds.IRON_AXE, name: 'iron_axe', displayName: 'Iron Axe', texture: 'iron_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.iron, damage: TOOL_DAMAGE.axe.iron } },
  { id: ItemIds.DIAMOND_AXE, name: 'diamond_axe', displayName: 'Diamond Axe', texture: 'diamond_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.diamond, damage: TOOL_DAMAGE.axe.diamond } },
  { id: ItemIds.GOLDEN_AXE, name: 'golden_axe', displayName: 'Golden Axe', texture: 'golden_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.golden, damage: TOOL_DAMAGE.axe.golden } },
  // Update #5: armor (15 pieces) and creative-only spawn eggs
  ...armorDefs(),
  { id: ItemIds.COW_SPAWN_EGG, name: 'cow_spawn_egg', displayName: 'Cow Spawn Egg', texture: 'cow_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'cow' },
  { id: ItemIds.PIG_SPAWN_EGG, name: 'pig_spawn_egg', displayName: 'Pig Spawn Egg', texture: 'pig_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'pig' },
  { id: ItemIds.SHEEP_SPAWN_EGG, name: 'sheep_spawn_egg', displayName: 'Sheep Spawn Egg', texture: 'sheep_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'sheep' },
]);
