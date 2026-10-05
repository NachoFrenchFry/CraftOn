// MobSpawner.js — deterministic group spawns for freshly generated chunks: about 1 in 6 chunks gets a
// group of 2–4 of one mob type on grass with two blocks of air above (never on sand, snow or in water).
// Pure: returns spawn positions; MobManager instantiates them.

import { chunkRandom } from '../../utils/Random.js';
import { BlockIds as B } from '../../blocks/BlockIds.js';
import { MOB_SPAWN_CHANCE } from '../../config/Constants.js';
import { COW } from './Cow.js';
import { PIG } from './Pig.js';
import { SHEEP } from './Sheep.js';

const SALT_MOBS = 0x0b0b5;
export const MOB_TYPES = Object.freeze([COW, PIG, SHEEP]);
export const MOB_BY_TYPE = Object.freeze(Object.fromEntries(MOB_TYPES.map((d) => [d.type, d])));

/**
 * @param {number} seed world seed
 * @param {import('../../world/Chunk.js').Chunk} chunk generated chunk data
 * @returns {{type:string, x:number, y:number, z:number, seed:number}[]}
 */
export function spawnsForChunk(seed, chunk) {
  const rng = chunkRandom(seed, chunk.cx, chunk.cz, SALT_MOBS);
  if (rng.next() >= MOB_SPAWN_CHANCE) return [];
  const def = MOB_TYPES[rng.nextInt(MOB_TYPES.length)];
  const count = 2 + rng.nextInt(3);
  const out = [];
  const b = chunk.blocks;
  for (let attempt = 0; attempt < count * 6 && out.length < count; attempt++) {
    const lx = rng.nextInt(16), lz = rng.nextInt(16);
    const h = chunk.heightMap[lx + (lz << 4)];
    // The actual top block may be lower (caves): scan down a little.
    let y = -1;
    for (let yy = h; yy > h - 4 && yy > 0; yy--) { if (b[lx + (lz << 4) + (yy << 8)] !== B.AIR) { y = yy; break; } }
    if (y < 0) continue;
    const ground = b[lx + (lz << 4) + (y << 8)];
    if (ground !== B.GRASS_BLOCK) continue; // grass only: no sand, snow, water
    if (b[lx + (lz << 4) + ((y + 1) << 8)] !== B.AIR || b[lx + (lz << 4) + ((y + 2) << 8)] !== B.AIR) continue;
    out.push({ type: def.type, x: chunk.cx * 16 + lx + 0.5, y: y + 1, z: chunk.cz * 16 + lz + 0.5, seed: rng.nextUint32() });
  }
  return out;
}
