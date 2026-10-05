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
  HAY_BALE: 35,
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
});

export const BLOCK_COUNT = 58;

/** Ids of blocks that no longer exist. Saved chunk edits holding them are converted to stone on load. */
export const REMOVED_BLOCK_IDS = Object.freeze([16, 28, 29]);
