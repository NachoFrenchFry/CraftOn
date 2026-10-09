// SpawnFinder.js — picks a spawn column by scoring candidates in an outward spiral (Update #6): inland
// land (continentalness clearly past the coast), height between sea level + 3 and + 30, plains or forest
// first (then any land biome except beach), gentle slopes, never a mountain peak. Pure terrain math, no
// chunks needed, so it also runs in Node checks.

import { SEA_LEVEL } from '../config/Constants.js';
import { BiomeIds } from './Biomes.js';
import { createColumnSample } from './TerrainShaper.js';

export const SPAWN_SEARCH_RADIUS = 256;
export const SPAWN_STEP = 4;
export const COAST_CONTINENT = 0.05;    // continentalness of the coastline in TerrainShaper's spline
export const INLAND_CONTINENT = 0.18;   // "clearly inland"

/**
 * Score one column; 0 means unusable.
 * @param {import('./WorldGenerator.js').WorldGenerator} gen
 */
export function scoreSpawnColumn(gen, x, z, sample = createColumnSample()) {
  const s = gen.shaper.sample(x, z, sample);
  const biome = gen.biomes.classify(s);
  const h = s.height;
  if (biome === BiomeIds.OCEAN || biome === BiomeIds.BEACH) return 0;
  if (h < SEA_LEVEL + 3 || h > SEA_LEVEL + 30) return 0;
  if (biome === BiomeIds.MOUNTAINS || s.mountain > 12) return 0;
  if (s.continent < COAST_CONTINENT + 0.04) return 0;
  let slope = 0;
  for (const [dx, dz] of [[SPAWN_STEP, 0], [-SPAWN_STEP, 0], [0, SPAWN_STEP], [0, -SPAWN_STEP]]) slope = Math.max(slope, Math.abs(gen.shaper.heightAt(x + dx, z + dz) - h));
  let score = 1;
  if (biome === BiomeIds.PLAINS || biome === BiomeIds.FOREST) score += 3;
  score += Math.min(2, (s.continent - COAST_CONTINENT) * 6);   // inland bonus
  if (s.continent >= INLAND_CONTINENT) score += 1;
  score += slope <= 2 ? 1.5 : slope <= 4 ? 0.5 : -1;
  score -= s.mountain * 0.1;
  return Math.max(0.01, score);
}

/**
 * Best spawn column within the search radius, or null when nothing qualifies.
 * @returns {{x:number, z:number, height:number, biome:number, continent:number, score:number}|null}
 */
export function findSpawnColumn(gen, radius = SPAWN_SEARCH_RADIUS, step = SPAWN_STEP, avoidLava = true) {
  const sample = createColumnSample();
  const rejected = new Set();
  for (let attempt = 0; attempt < 6; attempt++) {
    const best = searchSpawnColumn(gen, radius, step, sample, rejected);
    if (!best) return null;
    // Update #11: never spawn within about 16 blocks of lava (a desert lava lake); try the next best column instead.
    if (!avoidLava || !gen.lavaNear || !gen.lavaNear(best.x, best.z, 16, best.height - 24)) return best;
    rejected.add(best.x + ',' + best.z);
  }
  return searchSpawnColumn(gen, radius, step, sample, rejected);
}

function searchSpawnColumn(gen, radius, step, sample, rejected) {
  let best = null;
  const consider = (x, z) => {
    if (rejected.size && rejected.has(x + ',' + z)) return;
    const score = scoreSpawnColumn(gen, x, z, sample);
    if (score <= 0) return;
    const d = Math.hypot(x, z);
    const adjusted = score - d / radius * 1.5;  // prefer closer columns among equals
    if (!best || adjusted > best.adjusted) best = { x, z, adjusted, score, height: sample.height, biome: gen.biomes.classify(sample), continent: sample.continent };
  };
  consider(0, 0);
  for (let r = step; r <= radius; r += step) {
    for (let i = -r; i <= r; i += step) {
      consider(i, -r); consider(i, r);
      if (i > -r && i < r) { consider(-r, i); consider(r, i); }
    }
    if (best && best.score >= 7 && r >= 64) break; // an excellent spot close by: stop early
  }
  return best;
}
