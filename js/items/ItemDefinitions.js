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
  COOKED_BEEF: 295, COOKED_PORKCHOP: 296, COOKED_MUTTON: 297, // smelted from the raw meats
  // lava, sticks, torches, the gold tier, the storage blocks
  STICK: 298,
  LAVA_BUCKET: 299,
  GOLDEN_PICKAXE: 300, GOLDEN_AXE: 301, GOLDEN_SWORD: 302,
  GOLDEN_HELMET: 303, GOLDEN_CHESTPLATE: 304, GOLDEN_GAUNTLETS: 305, GOLDEN_LEGGINGS: 306, GOLDEN_BOOTS: 307,
  // string, the bow and its arrows
  STRING: 308,
  BOW: 309,
  ARROW: 310,
  ZOMBIE_SPAWN_EGG: 311,
  GLIDER: 312,
  ROCKET: 313,
  FEATHER: 314,
  RAW_CHICKEN: 315,
  COOKED_CHICKEN: 316,
  CHICKEN_SPAWN_EGG: 317,
  MACE: 318,
  WOODEN_SPEAR: 319, STONE_SPEAR: 320, GOLDEN_SPEAR: 321, IRON_SPEAR: 322, DIAMOND_SPEAR: 323,
  // shovels (Nov 6 2026); never renumber: saves store the ids
  WOODEN_SHOVEL: 324, STONE_SHOVEL: 325, GOLDEN_SHOVEL: 326, IRON_SHOVEL: 327, DIAMOND_SHOVEL: 328,
  // obsidian armor (Nov 8 2026): the fifth set, diamond's protection and more against explosions; never renumber
  OBSIDIAN_HELMET: 329, OBSIDIAN_CHESTPLATE: 330, OBSIDIAN_GAUNTLETS: 331, OBSIDIAN_LEGGINGS: 332, OBSIDIAN_BOOTS: 333,
});

/** Knockback points of the empty hand; an item's `knockback` replaces it (a stick: 10). Knockback strength scales with points / 5. */
export const HAND_KNOCKBACK = 5;
/** The bow's draw frames (textures): pulling_0 from the start, pulling_1 at 65 %, pulling_2 at 90 % of the 1 s draw. */
export const BOW_FRAMES = Object.freeze(['bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2']);

/** Armor slots in display order (the inventory's armor row). */
export const ARMOR_SLOTS = Object.freeze(['helmet', 'chestplate', 'gauntlets', 'leggings', 'boots']);
/** Armor points per material and piece (shown as "+N Armor"; 3 % of damage blocked per point, see Damage.js). */
export const ARMOR_POINTS = Object.freeze({
  wood: { helmet: 1, chestplate: 3, gauntlets: 1, leggings: 2, boots: 1 },     // 8
  gold: { helmet: 2, chestplate: 4, gauntlets: 1, leggings: 3, boots: 1 }, // 11 (between wood and iron)
  iron: { helmet: 2, chestplate: 6, gauntlets: 2, leggings: 5, boots: 2 },     // 17
  diamond: { helmet: 3, chestplate: 8, gauntlets: 3, leggings: 6, boots: 3 },  // 23
  obsidian: { helmet: 3, chestplate: 8, gauntlets: 3, leggings: 6, boots: 3 }, // 23 like diamond; ×1.5 against explosions (BLAST_ARMOR_MULTIPLIER)
});
/**
 * Against explosions a piece of these materials counts this many times its points (every other material once): an obsidian
 * chestplate is 8 points for a normal hit and 12 against a blast. The explosion cap is 85 % (Damage.EXPLOSION_ARMOR_CAP).
 */
export const BLAST_ARMOR_MULTIPLIER = Object.freeze({ obsidian: 1.5 });
/**
 * Armor points of a worn set given as { slot: material | null } (Inventory.armorMaterials(), a peer's replicated armor): the
 * plain points, or with `explosion` the points against an explosion (obsidian pieces × 1.5). The one per-slot loop, shared by
 * Inventory.armorPoints() / explosionArmorPoints() and HostServer._peerArmorPoints().
 */
export function armorPointsFor(materials, { explosion = false } = {}) {
  if (!materials) return 0;
  let n = 0;
  for (const slot of ARMOR_SLOTS) {
    const material = materials[slot];
    const pts = material && ARMOR_POINTS[material];
    if (!pts || !pts[slot]) continue;
    n += pts[slot] * (explosion ? BLAST_ARMOR_MULTIPLIER[material] || 1 : 1);
  }
  return n;
}
const PIECE_NAMES = { helmet: 'Helmet', chestplate: 'Chestplate', gauntlets: 'Gauntlets', leggings: 'Leggings', boots: 'Boots' };
const MATERIAL_NAMES = { wood: 'Wooden', gold: 'Golden', iron: 'Iron', diamond: 'Diamond', obsidian: 'Obsidian' };
const MATERIAL_PREFIX = { wood: 'wooden', gold: 'golden', iron: 'iron', diamond: 'diamond', obsidian: 'obsidian' };
const ARMOR_FIRST_ID = { wood: ItemIds.WOODEN_HELMET, iron: ItemIds.IRON_HELMET, diamond: ItemIds.DIAMOND_HELMET, gold: ItemIds.GOLDEN_HELMET, obsidian: ItemIds.OBSIDIAN_HELMET };
/** The tooltip line per material; everything not listed says 'Protects you'. */
const ARMOR_DESCRIPTION = { obsidian: 'Protects you, even more from explosions' };
function armorDefs() {
  const out = [];
  for (const material of ['wood', 'gold', 'iron', 'diamond', 'obsidian']) {
    let id = ARMOR_FIRST_ID[material];
    for (const slot of ARMOR_SLOTS) {
      const name = `${MATERIAL_PREFIX[material]}_${slot}`;
      out.push({ id: id++, name, displayName: `${MATERIAL_NAMES[material]} ${PIECE_NAMES[slot]}`, texture: name, stackSize: 1, placeable: false,
        armor: { slot, material, points: ARMOR_POINTS[material][slot] }, description: ARMOR_DESCRIPTION[material] || 'Protects you' });
    }
  }
  return out;
}

/**
 * Tier table: mining speed (pickaxe on stone-type, axe on wood-type, shovel on shovel-type blocks) and the attack damage per
 * tool — the real number a hit does to a player or a mob (Nov 6 2026: no hidden player scale; mobs have the health to match).
 *   hand 5  ·  wood ×4 (shovel ×2) pickaxe 10 / axe 15 / sword 20 / spear 5  ·  stone ×6 (×3) 15 / 20 / 25 / 10
 *   ·  gold ×8 (×4) 20 / 25 / 30 / 15  ·  iron ×10 (×5) 25 / 30 / 35 / 20  ·  diamond ×14 (×7) 30 / 35 / 40 / 25; shovels do a pickaxe's damage.
 * Stone by hand takes 6 s; with pickaxes 1.5 / 1.0 / 0.75 / 0.6 / ≈0.43 s. Dirt by hand 0.75 s; with shovels 0.38 / 0.25 / 0.19 /
 * 0.15 / 0.11 s (about half a pickaxe's multiplier: soils are already 8× softer and Survival has no delay between blocks).
 */
export const PICKAXE_SPEED = Object.freeze({ wooden: 4, stone: 6, golden: 8, iron: 10, diamond: 14 });
export const AXE_SPEED = Object.freeze({ wooden: 4, stone: 6, golden: 8, iron: 10, diamond: 14 });
export const SHOVEL_SPEED = Object.freeze({ wooden: 2, stone: 3, golden: 4, iron: 5, diamond: 7 });
export const TOOL_DAMAGE = Object.freeze({
  pickaxe: { wooden: 10, stone: 15, golden: 20, iron: 25, diamond: 30 },
  axe: { wooden: 15, stone: 20, golden: 25, iron: 30, diamond: 35 },
  sword: { wooden: 20, stone: 25, golden: 30, iron: 35, diamond: 40 },
  spear: { wooden: 5, stone: 10, golden: 15, iron: 20, diamond: 25 }, // sword − 15: the horizontal closing speed makes up the rest (Damage.js)
  shovel: { wooden: 10, stone: 15, golden: 20, iron: 25, diamond: 30 }, // a pickaxe's
});

/**
 * Fields: id, name, displayName, texture (16×16 icon / held sprite), stackSize, placeable (always false),
 * tool: { type: 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'mace' | 'spear', speed (pickaxes / axes / shovels), damage } for tools and weapons
 * (`damage` is the real number a hit does, shown as "N Attack Damage"; the mace's and the spears' grows with the closing speed, see Damage.js;
 * they mine like the hand and never break blocks in Creative, like the swords);
 * description: one short gray tooltip line saying what the item does (never how to use it; items without one show only their stats);
 * armor: { slot, material, points } for armor; spawnEgg: mob type (creative-only, never dropped or crafted);
 * food: { heal } for things you can eat (hold right click 1.6 s); knockback: knockback points when hitting with it
 * (the hand has HAND_KNOCKBACK); bow: true for the bow (hold right click to draw, release to shoot an arrow).
 */
export const ITEM_DEFINITIONS = Object.freeze([
  { id: ItemIds.COAL, name: 'coal', displayName: 'Coal', texture: 'coal', stackSize: 64, placeable: false },
  { id: ItemIds.IRON_INGOT, name: 'iron_ingot', displayName: 'Iron Ingot', texture: 'iron_ingot', stackSize: 64, placeable: false },
  { id: ItemIds.GOLD_INGOT, name: 'gold_ingot', displayName: 'Gold Ingot', texture: 'gold_ingot', stackSize: 64, placeable: false },
  { id: ItemIds.DIAMOND, name: 'diamond', displayName: 'Diamond', texture: 'diamond', stackSize: 64, placeable: false },
  { id: ItemIds.WOODEN_PICKAXE, name: 'wooden_pickaxe', displayName: 'Wooden Pickaxe', texture: 'wooden_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.wooden, damage: TOOL_DAMAGE.pickaxe.wooden }, description: 'Mines stone faster' },
  { id: ItemIds.STONE_PICKAXE, name: 'stone_pickaxe', displayName: 'Stone Pickaxe', texture: 'stone_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.stone, damage: TOOL_DAMAGE.pickaxe.stone }, description: 'Mines stone faster' },
  { id: ItemIds.IRON_PICKAXE, name: 'iron_pickaxe', displayName: 'Iron Pickaxe', texture: 'iron_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.iron, damage: TOOL_DAMAGE.pickaxe.iron }, description: 'Mines stone faster' },
  { id: ItemIds.DIAMOND_PICKAXE, name: 'diamond_pickaxe', displayName: 'Diamond Pickaxe', texture: 'diamond_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.diamond, damage: TOOL_DAMAGE.pickaxe.diamond }, description: 'Mines stone faster' },
  { id: ItemIds.GOLDEN_PICKAXE, name: 'golden_pickaxe', displayName: 'Golden Pickaxe', texture: 'golden_pickaxe', stackSize: 1, placeable: false, tool: { type: 'pickaxe', speed: PICKAXE_SPEED.golden, damage: TOOL_DAMAGE.pickaxe.golden }, description: 'Mines stone faster' },
  { id: ItemIds.WOODEN_SWORD, name: 'wooden_sword', displayName: 'Wooden Sword', texture: 'wooden_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.wooden }, description: 'Does damage' },
  { id: ItemIds.STONE_SWORD, name: 'stone_sword', displayName: 'Stone Sword', texture: 'stone_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.stone }, description: 'Does damage' },
  { id: ItemIds.IRON_SWORD, name: 'iron_sword', displayName: 'Iron Sword', texture: 'iron_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.iron }, description: 'Does damage' },
  { id: ItemIds.DIAMOND_SWORD, name: 'diamond_sword', displayName: 'Diamond Sword', texture: 'diamond_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.diamond }, description: 'Does damage' },
  { id: ItemIds.GOLDEN_SWORD, name: 'golden_sword', displayName: 'Golden Sword', texture: 'golden_sword', stackSize: 1, placeable: false, tool: { type: 'sword', damage: TOOL_DAMAGE.sword.golden }, description: 'Does damage' },
  { id: ItemIds.MACE, name: 'mace', displayName: 'Mace', texture: 'mace', stackSize: 1, placeable: false, tool: { type: 'mace', damage: 25 }, description: 'Hits harder the faster you fall' }, // damage = MACE_BASE_DAMAGE (Damage.js): 25 standing, more the faster you come down on the target
  // Spears: base 5–25 plus 2.5 per block/s of horizontal closing speed (Damage.js); held like swords, 1 material + 2 sticks.
  { id: ItemIds.WOODEN_SPEAR, name: 'wooden_spear', displayName: 'Wooden Spear', texture: 'wooden_spear', stackSize: 1, placeable: false, tool: { type: 'spear', damage: TOOL_DAMAGE.spear.wooden }, description: 'Hits harder the faster you move' },
  { id: ItemIds.STONE_SPEAR, name: 'stone_spear', displayName: 'Stone Spear', texture: 'stone_spear', stackSize: 1, placeable: false, tool: { type: 'spear', damage: TOOL_DAMAGE.spear.stone }, description: 'Hits harder the faster you move' },
  { id: ItemIds.GOLDEN_SPEAR, name: 'golden_spear', displayName: 'Golden Spear', texture: 'golden_spear', stackSize: 1, placeable: false, tool: { type: 'spear', damage: TOOL_DAMAGE.spear.golden }, description: 'Hits harder the faster you move' },
  { id: ItemIds.IRON_SPEAR, name: 'iron_spear', displayName: 'Iron Spear', texture: 'iron_spear', stackSize: 1, placeable: false, tool: { type: 'spear', damage: TOOL_DAMAGE.spear.iron }, description: 'Hits harder the faster you move' },
  { id: ItemIds.DIAMOND_SPEAR, name: 'diamond_spear', displayName: 'Diamond Spear', texture: 'diamond_spear', stackSize: 1, placeable: false, tool: { type: 'spear', damage: TOOL_DAMAGE.spear.diamond }, description: 'Hits harder the faster you move' },
  { id: ItemIds.BUCKET, name: 'bucket', displayName: 'Bucket', texture: 'bucket', stackSize: 16, placeable: false, description: 'Picks up liquids' },
  { id: ItemIds.WATER_BUCKET, name: 'water_bucket', displayName: 'Water Bucket', texture: 'water_bucket', stackSize: 1, placeable: false, description: 'Places water' },
  { id: ItemIds.LAVA_BUCKET, name: 'lava_bucket', displayName: 'Lava Bucket', texture: 'lava_bucket', stackSize: 1, placeable: false, description: 'Places lava' },
  { id: ItemIds.STICK, name: 'stick', displayName: 'Stick', texture: 'stick', stackSize: 1, placeable: false, knockback: HAND_KNOCKBACK + 5, description: 'Knocks things back' }, // a knockback weapon: no extra damage, +5 knockback, does not stack
  { id: ItemIds.STRING, name: 'string', displayName: 'String', texture: 'string', stackSize: 64, placeable: false },
  { id: ItemIds.BOW, name: 'bow', displayName: 'Bow', texture: 'bow', stackSize: 1, placeable: false, bow: true, description: 'Shoots arrows' },
  { id: ItemIds.ARROW, name: 'arrow', displayName: 'Arrow', texture: 'arrow', stackSize: 64, placeable: false, description: 'Ammo for bows' },
  { id: ItemIds.RAW_BEEF, name: 'raw_beef', displayName: 'Raw Beef', texture: 'raw_beef', stackSize: 64, placeable: false, food: { heal: 12 }, description: 'Restores health' },
  { id: ItemIds.RAW_PORKCHOP, name: 'raw_porkchop', displayName: 'Raw Porkchop', texture: 'raw_porkchop', stackSize: 64, placeable: false, food: { heal: 12 }, description: 'Restores health' },
  { id: ItemIds.RAW_MUTTON, name: 'raw_mutton', displayName: 'Raw Mutton', texture: 'raw_mutton', stackSize: 64, placeable: false, food: { heal: 10 }, description: 'Restores health' },
  { id: ItemIds.COOKED_BEEF, name: 'cooked_beef', displayName: 'Cooked Beef', texture: 'cooked_beef', stackSize: 64, placeable: false, food: { heal: 30 }, description: 'Restores health' },
  { id: ItemIds.COOKED_PORKCHOP, name: 'cooked_porkchop', displayName: 'Cooked Porkchop', texture: 'cooked_porkchop', stackSize: 64, placeable: false, food: { heal: 30 }, description: 'Restores health' },
  { id: ItemIds.COOKED_MUTTON, name: 'cooked_mutton', displayName: 'Cooked Mutton', texture: 'cooked_mutton', stackSize: 64, placeable: false, food: { heal: 25 }, description: 'Restores health' },
  { id: ItemIds.RAW_CHICKEN, name: 'raw_chicken', displayName: 'Raw Chicken', texture: 'raw_chicken', stackSize: 64, placeable: false, food: { heal: 10 }, description: 'Restores health' },
  { id: ItemIds.COOKED_CHICKEN, name: 'cooked_chicken', displayName: 'Cooked Chicken', texture: 'cooked_chicken', stackSize: 64, placeable: false, food: { heal: 20 }, description: 'Restores health' },
  { id: ItemIds.FEATHER, name: 'feather', displayName: 'Feather', texture: 'feather', stackSize: 64, placeable: false },
  // axes (wood-type blocks)
  { id: ItemIds.WOODEN_AXE, name: 'wooden_axe', displayName: 'Wooden Axe', texture: 'wooden_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.wooden, damage: TOOL_DAMAGE.axe.wooden }, description: 'Chops wood faster' },
  { id: ItemIds.STONE_AXE, name: 'stone_axe', displayName: 'Stone Axe', texture: 'stone_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.stone, damage: TOOL_DAMAGE.axe.stone }, description: 'Chops wood faster' },
  { id: ItemIds.IRON_AXE, name: 'iron_axe', displayName: 'Iron Axe', texture: 'iron_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.iron, damage: TOOL_DAMAGE.axe.iron }, description: 'Chops wood faster' },
  { id: ItemIds.DIAMOND_AXE, name: 'diamond_axe', displayName: 'Diamond Axe', texture: 'diamond_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.diamond, damage: TOOL_DAMAGE.axe.diamond }, description: 'Chops wood faster' },
  { id: ItemIds.GOLDEN_AXE, name: 'golden_axe', displayName: 'Golden Axe', texture: 'golden_axe', stackSize: 1, placeable: false, tool: { type: 'axe', speed: AXE_SPEED.golden, damage: TOOL_DAMAGE.axe.golden }, description: 'Chops wood faster' },
  // shovels (shovel-type blocks: grass, dirt, sand, gravel, clay, snow; Nov 6 2026)
  { id: ItemIds.WOODEN_SHOVEL, name: 'wooden_shovel', displayName: 'Wooden Shovel', texture: 'wooden_shovel', stackSize: 1, placeable: false, tool: { type: 'shovel', speed: SHOVEL_SPEED.wooden, damage: TOOL_DAMAGE.shovel.wooden }, description: 'Digs dirt and sand faster' },
  { id: ItemIds.STONE_SHOVEL, name: 'stone_shovel', displayName: 'Stone Shovel', texture: 'stone_shovel', stackSize: 1, placeable: false, tool: { type: 'shovel', speed: SHOVEL_SPEED.stone, damage: TOOL_DAMAGE.shovel.stone }, description: 'Digs dirt and sand faster' },
  { id: ItemIds.GOLDEN_SHOVEL, name: 'golden_shovel', displayName: 'Golden Shovel', texture: 'golden_shovel', stackSize: 1, placeable: false, tool: { type: 'shovel', speed: SHOVEL_SPEED.golden, damage: TOOL_DAMAGE.shovel.golden }, description: 'Digs dirt and sand faster' },
  { id: ItemIds.IRON_SHOVEL, name: 'iron_shovel', displayName: 'Iron Shovel', texture: 'iron_shovel', stackSize: 1, placeable: false, tool: { type: 'shovel', speed: SHOVEL_SPEED.iron, damage: TOOL_DAMAGE.shovel.iron }, description: 'Digs dirt and sand faster' },
  { id: ItemIds.DIAMOND_SHOVEL, name: 'diamond_shovel', displayName: 'Diamond Shovel', texture: 'diamond_shovel', stackSize: 1, placeable: false, tool: { type: 'shovel', speed: SHOVEL_SPEED.diamond, damage: TOOL_DAMAGE.shovel.diamond }, description: 'Digs dirt and sand faster' },
  // armor (15 pieces) and creative-only spawn eggs
  ...armorDefs(),
  { id: ItemIds.COW_SPAWN_EGG, name: 'cow_spawn_egg', displayName: 'Cow Spawn Egg', texture: 'cow_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'cow', description: 'Spawns a cow' },
  { id: ItemIds.PIG_SPAWN_EGG, name: 'pig_spawn_egg', displayName: 'Pig Spawn Egg', texture: 'pig_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'pig', description: 'Spawns a pig' },
  { id: ItemIds.SHEEP_SPAWN_EGG, name: 'sheep_spawn_egg', displayName: 'Sheep Spawn Egg', texture: 'sheep_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'sheep', description: 'Spawns a sheep' },
  { id: ItemIds.ZOMBIE_SPAWN_EGG, name: 'zombie_spawn_egg', displayName: 'Zombie Spawn Egg', texture: 'zombie_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'zombie', description: 'Spawns a zombie' },
  { id: ItemIds.GLIDER, name: 'glider', displayName: 'Glider', texture: 'glider', stackSize: 1, placeable: false, glider: true, description: 'Lets you fly' }, // craftable since Nov 5 2026 (10 iron ingots + 2 obsidian)
  { id: ItemIds.ROCKET, name: 'rocket', displayName: 'Rocket', texture: 'rocket', stackSize: 64, placeable: false, rocket: true, description: 'Boosts you forward' },
  { id: ItemIds.CHICKEN_SPAWN_EGG, name: 'chicken_spawn_egg', displayName: 'Chicken Spawn Egg', texture: 'chicken_spawn_egg', stackSize: 64, placeable: false, creativeOnly: true, spawnEgg: 'chicken', description: 'Spawns a chicken' },
]);
