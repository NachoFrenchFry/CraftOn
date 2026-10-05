// BiomeProvider.js — classifies a column into a biome from temperature, humidity, height and
// mountain-ness. Pure per column so neighbouring chunks agree. Deserts need temperature > 0.42 and snow
// needs < -0.40; temperature is continuous and altitude cooling is capped at 0.25, so a temperate band
// of plains / forest always lies between hot and cold climates. Worker-safe.

import { SEA_LEVEL } from '../config/Constants.js';
import { BiomeIds, BIOMES } from './Biomes.js';

const MOUNTAIN_THRESHOLD = 20;
export const SNOW_BELOW = -0.40;
export const DESERT_ABOVE = 0.42;

export class BiomeProvider {
  /** @param {import('./TerrainShaper.js').TerrainShaper} shaper */
  constructor(seed, shaper) {
    this.seed = seed;
    this.shaper = shaper;
  }

  /** Biome id from a column sample produced by TerrainShaper.sample(). */
  classify(s) {
    const h = s.height;
    if (h < SEA_LEVEL - 4) return BiomeIds.OCEAN;
    if (h <= SEA_LEVEL + 1) return BiomeIds.BEACH;
    if (s.mountain > MOUNTAIN_THRESHOLD) return BiomeIds.MOUNTAINS;
    if (s.temperature < SNOW_BELOW) return BiomeIds.SNOWY;
    if (s.temperature > DESERT_ABOVE && s.humidity < 0.0) return BiomeIds.DESERT;
    if (s.humidity > 0.12) return BiomeIds.FOREST;
    return BiomeIds.PLAINS;
  }

  get(id) { return BIOMES[id]; }
}
