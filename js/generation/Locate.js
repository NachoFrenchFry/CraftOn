// Locate.js — /locate searches that never generate chunks: the nearest structure start (the Part 1 region-grid math of
// StructurePlacer, evaluated from the generator's pure height and biome functions) and the nearest biome (a square
// spiral over the biome function at a coarse step, then refined to the nearest cell). Worker-safe; runs in a chunk
// worker for the game and in Node for the checks.

import { BIOMES, BiomeIds } from './Biomes.js';

/** How far /locate looks (blocks). */
export const LOCATE_MAX_DISTANCE = 6400;
/** The biome names /locate accepts, indexed by BiomeIds. */
export const BIOME_NAMES = ['ocean', 'beach', 'plains', 'forest', 'desert', 'snowy', 'mountains'];
export function biomeIdOf(name) { const i = BIOME_NAMES.indexOf(String(name).toLowerCase()); return i; }
export function biomeLabel(name) { const i = biomeIdOf(name); return i >= 0 ? BIOMES[i].name : String(name); }

/**
 * The nearest cell of a biome: rings of a coarse grid (`coarse` blocks apart) around (x, z) until a ring cannot beat
 * the best hit, then the neighbourhood of the hit at step 4 and step 1.
 * @returns {{x: number, y: number, z: number, distance: number}|null}
 */
export function locateBiome(gen, biomeId, x, z, maxDist = LOCATE_MAX_DISTANCE, coarse = 32) {
  if (biomeId < 0 || biomeId > BiomeIds.MOUNTAINS) return null;
  const is = (px, pz) => gen.biomeAt(px, pz) === biomeId;
  let best = null;
  const R = Math.ceil(maxDist / coarse);
  const consider = (i, j) => {
    const d = Math.hypot(i * coarse, j * coarse);
    if (d > maxDist || (best && d >= best.d)) return;
    const px = x + i * coarse, pz = z + j * coarse;
    if (is(px, pz)) best = { x: px, z: pz, d };
  };
  for (let k = 0; k <= R; k++) {
    if (best && k * coarse >= best.d) break; // every point of this ring is at least k·coarse away
    if (k === 0) { consider(0, 0); continue; }
    for (let i = -k; i <= k; i++) { consider(i, -k); consider(i, k); }
    for (let j = -k + 1; j <= k - 1; j++) { consider(-k, j); consider(k, j); }
  }
  if (!best) return null;
  for (const [range, step] of [[coarse, 4], [4, 1]]) {
    const centre = best;
    for (let dz = -range; dz <= range; dz += step) for (let dx = -range; dx <= range; dx += step) {
      const px = centre.x + dx, pz = centre.z + dz, d = Math.hypot(px - x, pz - z);
      if (d < best.d && is(px, pz)) best = { x: px, z: pz, d };
    }
  }
  return { x: best.x, y: gen.surfaceHeight(best.x, best.z) + 1, z: best.z, distance: Math.round(best.d) };
}

/** The nearest start of a structure (StructurePlacer.nearest), or null. */
export function locateStructure(gen, name, x, z, maxDist = LOCATE_MAX_DISTANCE) {
  if (!gen.structures) return null;
  const st = gen.structures.nearest(name, x, z, maxDist);
  return st ? { x: st.x, y: st.y, z: st.z, distance: Math.round(Math.hypot(st.x - x, st.z - z)), rotation: st.rot } : null;
}

/** `kind` 'biome' | 'structure'. */
export function locate(gen, kind, name, x, z, maxDist = LOCATE_MAX_DISTANCE) {
  return kind === 'biome' ? locateBiome(gen, biomeIdOf(name), x, z, maxDist) : locateStructure(gen, name, x, z, maxDist);
}
