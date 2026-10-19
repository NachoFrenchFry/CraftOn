// Explosion.js — Minecraft's explosion ray algorithm, pure so the Node check can run it on a stub world: 16×16×16 grid
// rays from the centre (only the outer shell of the grid), each starting with intensity power × (0.7 + random 0.6),
// stepping 0.3 blocks and losing 0.225 + (blastResistance + 0.3) × 0.3 per step; a block a ray reaches with intensity
// left is destroyed (immune blocks — Infinity — swallow the ray). Also the exposure of an entity box (the fraction of
// rays from the centre to a grid of points in the box that no block interrupts) and the damage / knockback helpers.

import { BLAST_RESISTANCE } from '../blocks/BlockRegistry.js';
import { EXPLOSION_RAY_STEP } from '../config/Constants.js';
import { explosionImpact } from '../player/Damage.js';

/**
 * The blocks an explosion of `power` at (cx, cy, cz) destroys, as [[x, y, z], …] (each once). `getBlock(x, y, z)` reads
 * the world; `rng()` is a 0..1 source (seeded in tests).
 */
export function explosionBlocks(getBlock, cx, cy, cz, power, rng = Math.random) {
  const out = [];
  const seen = new Set();
  const N = 16;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
    if (i !== 0 && i !== N - 1 && j !== 0 && j !== N - 1 && k !== 0 && k !== N - 1) continue; // the shell only
    let dx = i / (N - 1) * 2 - 1, dy = j / (N - 1) * 2 - 1, dz = k / (N - 1) * 2 - 1;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    let intensity = power * (0.7 + rng() * 0.6);
    let x = cx, y = cy, z = cz;
    while (intensity > 0) {
      const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
      const id = getBlock(bx, by, bz);
      if (id !== 0) {
        const r = BLAST_RESISTANCE[id];
        if (r === Infinity) break; // obsidian, bedrock, the void: the ray ends here
        intensity -= (r + 0.3) * 0.3;
        if (intensity > 0) {
          const key = ((bx + 1024) & 2047) | (((bz + 1024) & 2047) << 11) | ((by & 255) << 22);
          if (!seen.has(key)) { seen.add(key); out.push([bx, by, bz]); }
        }
      }
      intensity -= 0.225;
      x += dx * EXPLOSION_RAY_STEP; y += dy * EXPLOSION_RAY_STEP; z += dz * EXPLOSION_RAY_STEP;
    }
  }
  return out;
}

/**
 * Fraction of sample points in the box (minX..maxX, …) that the explosion centre can see: `blocked(ox, oy, oz, tx, ty, tz)`
 * is true when a solid block lies on the segment. Points sit on a grid of 2·size+1 steps per axis (at most 4 per axis).
 */
export function explosionExposure(blocked, cx, cy, cz, box) {
  const steps = (lo, hi) => Math.max(2, Math.min(4, Math.round((hi - lo) * 2) + 1));
  const nx = steps(box.minX, box.maxX), ny = steps(box.minY, box.maxY), nz = steps(box.minZ, box.maxZ);
  let seen = 0, total = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    const px = box.minX + (box.maxX - box.minX) * (nx === 1 ? 0.5 : i / (nx - 1));
    const py = box.minY + (box.maxY - box.minY) * (ny === 1 ? 0.5 : j / (ny - 1));
    const pz = box.minZ + (box.maxZ - box.minZ) * (nz === 1 ? 0.5 : k / (nz - 1));
    total++;
    if (!blocked(cx, cy, cz, px, py, pz)) seen++;
  }
  return total ? seen / total : 0;
}

/** Impact (0..1) of an explosion on a box: distance from the centre to the box's centre against the 2 × power radius, times the exposure. */
export function explosionImpactOn(blocked, cx, cy, cz, box, power) {
  const mx = (box.minX + box.maxX) / 2, my = (box.minY + box.maxY) / 2, mz = (box.minZ + box.maxZ) / 2;
  const d = Math.hypot(mx - cx, my - cy, mz - cz);
  if (d >= power * 2) return { impact: 0, distance: d, dirX: 0, dirY: 0, dirZ: 0 };
  const exposure = explosionExposure(blocked, cx, cy, cz, box);
  const impact = explosionImpact(d, exposure, power);
  const len = d || 1;
  return { impact, distance: d, exposure, dirX: (mx - cx) / len, dirY: (my - cy) / len, dirZ: (mz - cz) / len };
}
