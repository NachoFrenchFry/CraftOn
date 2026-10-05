// Biomes.js — biome ids and per-biome surface blocks, tree shapes and decoration densities.
// Worker-safe. To add a biome: add an entry here and a classification rule in BiomeProvider.js.

import { BlockIds as B } from '../blocks/BlockIds.js';

export const BiomeIds = Object.freeze({
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, SNOWY: 5, MOUNTAINS: 6,
});

export const TreeType = Object.freeze({ ROUND: 0, TALL: 1, CONICAL: 2 });

/**
 * treeDensity: probability that one of the ~10 per-chunk tree attempts succeeds.
 * grassDensity / flowerDensity: per-column probabilities for plants.
 */
export const BIOMES = [
  { id: BiomeIds.OCEAN, name: 'Ocean', top: B.SAND, filler: B.SAND, fillerDepth: 3, treeDensity: 0, treeTypes: [], grassDensity: 0, flowerDensity: 0, cactusDensity: 0, deadBushDensity: 0 },
  { id: BiomeIds.BEACH, name: 'Beach', top: B.SAND, filler: B.SAND, fillerDepth: 3, subFiller: B.SANDSTONE, subFillerDepth: 3, treeDensity: 0, treeTypes: [], grassDensity: 0, flowerDensity: 0, cactusDensity: 0, deadBushDensity: 0 },
  { id: BiomeIds.PLAINS, name: 'Plains', top: B.GRASS_BLOCK, filler: B.DIRT, fillerDepth: 3, treeDensity: 0.05, treeTypes: [TreeType.ROUND], grassDensity: 0.22, flowerDensity: 0.035, cactusDensity: 0, deadBushDensity: 0 },
  { id: BiomeIds.FOREST, name: 'Forest', top: B.GRASS_BLOCK, filler: B.DIRT, fillerDepth: 3, treeDensity: 0.62, treeTypes: [TreeType.ROUND, TreeType.ROUND, TreeType.TALL], grassDensity: 0.08, flowerDensity: 0.015, cactusDensity: 0, deadBushDensity: 0 },
  { id: BiomeIds.DESERT, name: 'Desert', top: B.SAND, filler: B.SAND, fillerDepth: 4, subFiller: B.SANDSTONE, subFillerDepth: 3, treeDensity: 0, treeTypes: [], grassDensity: 0, flowerDensity: 0, cactusDensity: 0.012, deadBushDensity: 0.01 },
  { id: BiomeIds.SNOWY, name: 'Snowy Taiga', top: B.SNOWY_GRASS, filler: B.DIRT, fillerDepth: 3, treeDensity: 0.28, treeTypes: [TreeType.CONICAL], grassDensity: 0.02, flowerDensity: 0, cactusDensity: 0, deadBushDensity: 0 },
  { id: BiomeIds.MOUNTAINS, name: 'Mountains', top: B.GRASS_BLOCK, filler: B.DIRT, fillerDepth: 2, treeDensity: 0.08, treeTypes: [TreeType.CONICAL], grassDensity: 0.05, flowerDensity: 0.005, cactusDensity: 0, deadBushDensity: 0 },
];

import { SNOW_LINE_Y } from '../config/Constants.js';
export const SNOW_LINE = SNOW_LINE_Y;

export function biomeName(id) {
  const b = BIOMES[id];
  return b ? b.name : 'Unknown';
}

/** Blocks a tree may grow on. */
export function isTreeSoil(id) {
  return id === B.GRASS_BLOCK || id === B.DIRT || id === B.SNOWY_GRASS;
}
