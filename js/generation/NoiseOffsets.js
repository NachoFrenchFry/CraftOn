// NoiseOffsets.js — seeded per-field coordinate offsets (Update #6). Gradient noise is always 0 at the
// origin, so without offsets every seed had continentalness, erosion, temperature and humidity all near 0
// at (0, 0): exactly the coastline and the biome boundaries. Each field now samples at (x + offX,
// z + offZ) with large random offsets derived from the seed and a field index, so no field is pinned at
// the origin and every field's zero lands somewhere different per seed. Worker-safe.

import { Random, deriveSeed } from '../utils/Random.js';

export const OFFSET_RANGE = 100000;

/** [offX, offY, offZ] for field `index` of `seed`, each within ±OFFSET_RANGE. */
export function fieldOffset(seed, index) {
  const rng = new Random(deriveSeed(seed, 0x0ff5e7 + index * 7919));
  return [
    (rng.next() * 2 - 1) * OFFSET_RANGE,
    (rng.next() * 2 - 1) * OFFSET_RANGE,
    (rng.next() * 2 - 1) * OFFSET_RANGE,
  ];
}
