// BlockIds.js — numeric block ids. AIR must be 0. Ids fit in a Uint8Array.

export const BlockIds = Object.freeze({
  AIR: 0,
  STONE: 1,
  GRASS_BLOCK: 2,        // the turf block (was GRASS)
  DIRT: 3,
  COBBLESTONE: 4,
  PLANKS: 5,
  BEDROCK: 6,
  WATER: 7,
  SAND: 8,
  GRAVEL: 9,
  GOLD_ORE: 10,
  IRON_ORE: 11,
  COAL_ORE: 12,
  LOG: 13,
  LEAVES: 14,
  GLASS: 15,
  // 16: lapis ore (removed in Update #4; number stays unused so saves keep working)
  SANDSTONE: 17,
  GRASS: 18,             // the small plant (was TALL_GRASS)
  FLOWER_YELLOW: 19,
  FLOWER_RED: 20,
  BRICKS: 21,
  SNOW: 22,
  SNOWY_GRASS: 23,
  CLAY: 24,
  CACTUS: 25,
  STONE_BRICKS: 26,
  DIAMOND_ORE: 27,
  // 28, 29: redstone and emerald ore (removed in Update #4; numbers stay unused)
  ICE: 30,
  DEAD_BUSH: 31,
  MOSSY_COBBLESTONE: 32,
  CRACKED_STONE_BRICKS: 33,
  OBSIDIAN: 34,
  // 35: hay bale (removed in Update #11; placed ones become air on load, the number stays unused)
  CONCRETE: 36,          // was TERRACOTTA; same id so old saves turn into concrete
  WOOL_WHITE: 37,
  WOOL_RED: 38,
  WOOL_BLUE: 39,
  // Flowing water levels 1..7 (weaker further from the source) and falling water. WATER (7) is the source.
  FLOWING_WATER_1: 40,
  FLOWING_WATER_2: 41,
  FLOWING_WATER_3: 42,
  FLOWING_WATER_4: 43,
  FLOWING_WATER_5: 44,
  FLOWING_WATER_6: 45,
  FLOWING_WATER_7: 46,
  FALLING_WATER: 47,
  // Stations: the base id faces south; the other three ids are the same block facing north / east / west.
  CRAFTING_TABLE: 48,
  CRAFTING_TABLE_N: 49,
  CRAFTING_TABLE_E: 50,
  CRAFTING_TABLE_W: 51,
  FURNACE: 52,
  FURNACE_N: 53,
  FURNACE_E: 54,
  FURNACE_W: 55,
  // Log orientation (Update #6): LOG is vertical (Y); the variants lie along X / Z. Base item stays LOG.
  LOG_X: 56,
  LOG_Z: 57,
  // Lava (Update #11): LAVA is the source; flowing levels 1..3 (it spreads 3 blocks) and falling lava.
  LAVA: 58,
  FLOWING_LAVA_1: 59,
  FLOWING_LAVA_2: 60,
  FLOWING_LAVA_3: 61,
  FALLING_LAVA: 62,
  FLOWER_BLUE: 63,
  // Torches (Update #11): TORCH stands on the block below; the variants hang on the wall to their north / south / east / west.
  TORCH: 64,
  TORCH_N: 65,
  TORCH_S: 66,
  TORCH_E: 67,
  TORCH_W: 68,
  // Storage blocks (Update #11): 9 of the material ↔ 1 block.
  COAL_BLOCK: 69,
  IRON_BLOCK: 70,
  GOLD_BLOCK: 71,
  DIAMOND_BLOCK: 72,
});

export const BLOCK_COUNT = 73;

/** Ids of blocks that no longer exist. Saved chunk edits holding them are converted to stone on load. */
export const REMOVED_BLOCK_IDS = Object.freeze([16, 28, 29]);
/** Removed blocks that become air instead (the hay bale, Update #11). */
export const REMOVED_TO_AIR_IDS = Object.freeze([35]);
