// LightSeams.js — the seam pass (Update #10): when a freshly lit chunk joins already-lit neighbours, the shared
// borders are compared and every cell that could brighten the cell across the border is queued for
// propagation. Both chunks were lit from exact 3×3 block data, so normally nothing is queued; the pass catches
// edits made in a neighbour while this chunk's light job was still in flight, and keeps the result identical
// whichever chunk loaded first. Pure (works on any LightEngine access object).
import { LIGHT_MAX } from './LightStorage.js';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../config/Constants.js';

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
