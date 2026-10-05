// TreeGenerator.js — tree shapes (round / tall / conical) and cacti, all using the single provided
// log and leaves. Shapes are written through a callback so callers can clip to their chunk.
// Worker-safe.

import { Random } from '../utils/Random.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { TreeType } from './Biomes.js';

/** Bounding radius (horizontal) and height used to test chunk overlap. */
export const TREE_MAX_RADIUS = 2;
export const TREE_MAX_HEIGHT = 12;

/**
 * Deterministic tree parameters from a spec seed.
 * @returns {{trunkHeight:number}}
 */
export function treeParams(type, seed) {
  const rng = new Random(seed);
  if (type === TreeType.CONICAL) return { trunkHeight: rng.nextIntRange(6, 9), rng };
  if (type === TreeType.TALL) return { trunkHeight: rng.nextIntRange(5, 7), rng };
  return { trunkHeight: rng.nextIntRange(4, 6), rng };
}

/**
 * Build a tree at (x, y, z) where y is the first trunk block (ground + 1).
 * write(wx, wy, wz, blockId, isTrunk) is called for every block; it must clip/merge itself.
 */
export function buildTree(spec, write) {
  const { x, y, z, type } = spec;
  const { trunkHeight, rng } = treeParams(type, spec.seed);
  if (type === TreeType.CONICAL) return buildConical(x, y, z, trunkHeight, rng, write);
  return buildRound(x, y, z, trunkHeight, rng, write);
}

function buildRound(x, y, z, th, rng, write) {
  const topY = y + th; // one above the last trunk block
  // Two 5×5 layers minus random corners, then 3×3, then a plus-shaped top.
  for (let dy = -3; dy <= 0; dy++) {
    const ly = topY + dy;
    const r = dy <= -2 ? 2 : 1;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const corner = Math.abs(dx) === r && Math.abs(dz) === r;
        if (corner && (dy === 0 || (r === 2 && rng.chance(0.5)))) continue;
        write(x + dx, ly, z + dz, B.LEAVES, false);
      }
    }
  }
  for (let i = 0; i < th; i++) write(x, y + i, z, B.LOG, true);
}

function buildConical(x, y, z, th, rng, write) {
  const tipY = y + th; // leaf above the trunk top
  write(x, tipY, z, B.LEAVES, false);
  // Alternating radii below the tip; bottom two trunk blocks stay bare.
  const pattern = [1, 1, 2, 1, 2, 1, 2, 2, 2];
  let pi = 0;
  for (let ly = tipY - 1; ly >= y + 2; ly--, pi++) {
    const r = pattern[Math.min(pi, pattern.length - 1)];
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        write(x + dx, ly, z + dz, B.LEAVES, false);
      }
    }
  }
  for (let i = 0; i < th; i++) write(x, y + i, z, B.LOG, true);
}

/** Cactus of 1–3 blocks starting at y. */
export function buildCactus(x, y, z, rng, write) {
  const h = rng.nextIntRange(1, 3);
  for (let i = 0; i < h; i++) write(x, y + i, z, B.CACTUS, true);
}
