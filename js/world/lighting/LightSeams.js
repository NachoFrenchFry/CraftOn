// LightSeams.js — the seam pass (Update #10): when a freshly lit chunk joins already-lit neighbours, the shared
// borders are compared and every cell that could brighten the cell across the border is queued for
// propagation. Both chunks were lit from exact 3×3 block data, so normally nothing is queued; the pass catches
// edits made in a neighbour while this chunk's light job was still in flight, and keeps the result identical
// whichever chunk loaded first. Pure (works on any LightEngine access object).
import { LIGHT_MAX, lightIndex } from './LightStorage.js';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../config/Constants.js';
import { LIGHT_OPACITY } from '../../blocks/BlockRegistry.js';
import { blockIndex } from '../ChunkCoords.js';

/**
 * Compare the border between chunk (cx, cz) and its neighbour on `side` ('west' | 'east' | 'north' | 'south')
 * and push mismatched cells to `queue`. Returns how many cells were queued.
 */
export function seamPass(access, channel, cx, cz, side, queue) {
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
  let pushed = 0;
  const compare = (ax, ay, az, bx, by, bz) => {
    const a = access.get(ax, ay, az, channel), b = access.get(bx, by, bz, channel);
    if (a > 1 && a - 1 - access.opacity(bx, by, bz) > b && access.opacity(bx, by, bz) < LIGHT_MAX) { queue.push(ax, ay, az, a); pushed++; }
    if (b > 1 && b - 1 - access.opacity(ax, ay, az) > a && access.opacity(ax, ay, az) < LIGHT_MAX) { queue.push(bx, by, bz, b); pushed++; }
  };
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    if (side === 'west' || side === 'east') {
      const ax = side === 'west' ? x0 : x0 + CHUNK_SIZE - 1, bx = side === 'west' ? x0 - 1 : x0 + CHUNK_SIZE;
      for (let z = 0; z < CHUNK_SIZE; z++) compare(ax, y, z0 + z, bx, y, z0 + z);
    } else {
      const az = side === 'north' ? z0 : z0 + CHUNK_SIZE - 1, bz = side === 'north' ? z0 - 1 : z0 + CHUNK_SIZE;
      for (let x = 0; x < CHUNK_SIZE; x++) compare(x0 + x, y, az, x0 + x, y, bz);
    }
  }
  return pushed;
}

export const SEAM_SIDES = Object.freeze([['west', -1, 0], ['east', 1, 0], ['north', 0, -1], ['south', 0, 1]]);

/**
 * The same comparison straight over the two chunks' light and block arrays, both channels in one pass, for the rows y0 ≤ y < y1
 * (Update #14 §1c: the accessor version above cost ~100 ms per chunk through map lookups; this one runs in time slices inside the
 * per-frame light budget). Mismatches are pushed to `skyQueue` / `blockQueue`. Returns how many cells were queued.
 */
export function seamSlice(world, cx, cz, dx, dz, y0, y1, skyQueue, blockQueue) {
  const a = world.getChunk(cx, cz), b = world.getChunk(cx + dx, cz + dz);
  if (!a || !b || !a.lit || !b.lit) return 0;
  const al = a.light, bl = b.light, ab = a.blocks, bb = b.blocks;
  const horizontal = dx !== 0;
  const alx = dx < 0 ? 0 : 15, blx = dx < 0 ? 15 : 0, alz = dz < 0 ? 0 : 15, blz = dz < 0 ? 15 : 0;
  const ax0 = cx * CHUNK_SIZE, az0 = cz * CHUNK_SIZE, bx0 = (cx + dx) * CHUNK_SIZE, bz0 = (cz + dz) * CHUNK_SIZE;
  let pushed = 0;
  for (let y = y0; y < y1; y++) {
    for (let k = 0; k < CHUNK_SIZE; k++) {
      const ax = horizontal ? alx : k, az = horizontal ? k : alz, bx = horizontal ? blx : k, bz = horizontal ? k : blz;
      const av = al[lightIndex(ax, y, az)], bv = bl[lightIndex(bx, y, bz)];
      const ao = LIGHT_OPACITY[ab[blockIndex(ax, y, az)]], bo = LIGHT_OPACITY[bb[blockIndex(bx, y, bz)]];
      const s1 = av & 15, s2 = bv & 15;
      if (s1 > 1 && s1 - 1 - bo > s2 && bo < LIGHT_MAX) { skyQueue.push(ax0 + ax, y, az0 + az, s1); pushed++; }
      if (s2 > 1 && s2 - 1 - ao > s1 && ao < LIGHT_MAX) { skyQueue.push(bx0 + bx, y, bz0 + bz, s2); pushed++; }
      const k1 = av >> 4, k2 = bv >> 4;
      if (k1 > 1 && k1 - 1 - bo > k2 && bo < LIGHT_MAX) { blockQueue.push(ax0 + ax, y, az0 + az, k1); pushed++; }
      if (k2 > 1 && k2 - 1 - ao > k1 && ao < LIGHT_MAX) { blockQueue.push(bx0 + bx, y, bz0 + bz, k2); pushed++; }
    }
  }
  return pushed;
}
