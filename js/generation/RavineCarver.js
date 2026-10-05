// RavineCarver.js — long, narrow, very deep cracks like Minecraft's ravines (Update #8), carved with the worm
// approach of CaveCarver but with a tall vertical radius: 3–7 blocks wide, 40–80 deep (from the surface down
// to about y 15–20), 60–120 long, slightly jagged walls, about one per RAVINE_CHUNK_CHANCE chunks. A ravine
// is a deterministic path of discs computed once per source chunk (cached) and carved into every chunk it
// crosses, so it continues seamlessly across chunk borders. It opens at the surface on land only: columns at
// or below sea level + 2 (oceans, rivers, beaches) are never cut, nothing is carved below MIN_CAVE_Y, and
// water blocks are left alone. Worker-safe.

import { Random, chunkRandom } from '../utils/Random.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { MIN_CAVE_Y, SEA_LEVEL, RAVINE_CHUNK_CHANCE } from '../config/Constants.js';
import { isWater } from '../world/WaterLevels.js';
import { clamp } from '../utils/MathUtils.js';

const SALT = 0x5a71e;
/** Source chunks within this many chunks can reach the current chunk (paths are at most 120 blocks long). */
const RANGE = 8;
const PATH_CACHE_LIMIT = 512;
export const RAVINE_MIN_LENGTH = 60, RAVINE_MAX_LENGTH = 120;
export const RAVINE_MIN_DEPTH = 40, RAVINE_MAX_DEPTH = 80;
export const RAVINE_MIN_RADIUS = 1.5, RAVINE_MAX_RADIUS = 3.5;
/** Land columns only: nothing at or below this height is ever cut (oceans, rivers, beaches). */
export const RAVINE_MIN_SURFACE = SEA_LEVEL + 3;

/**
 * Does source chunk (scx, scz) start a ravine? Returns its start { x, z, surface, rng } or null. Pure and cheap
 * (one or two random numbers for the chunks that roll nothing), so the Node check can count ravines quickly.
 */
export function ravineSource(seed, scx, scz, shaper) {
  const rng = chunkRandom(seed, scx, scz, SALT);
  if (rng.nextInt(RAVINE_CHUNK_CHANCE) !== 0) return null;
  const x = scx * 16 + rng.nextInt(16), z = scz * 16 + rng.nextInt(16);
  const surface = shaper.heightAt(x, z);
  if (surface < RAVINE_MIN_SURFACE) return null;
  return { x, z, surface, rng };
}

export class RavineCarver {
  /** @param {import('./TerrainShaper.js').TerrainShaper} shaper for the surface height at a ravine's start */
  constructor(seed, shaper) {
    this.seed = seed;
    this.shaper = shaper;
    /** source chunk key → disc path or null (bounded cache). */
    this.paths = new Map();
    /** Discs near the chunk carved last (for the tree-placement check of that chunk and its margin). */
    this.activeDiscs = [];
    this.activeCX = null; this.activeCZ = null;
  }

  /** The disc path of the ravine starting in source chunk (scx, scz), or null. Cached. */
  path(scx, scz) {
    const key = (scx + 1048576) * 2097152 + (scz + 1048576);
    const cached = this.paths.get(key);
    if (cached !== undefined) return cached;
    const src = ravineSource(this.seed, scx, scz, this.shaper);
    const path = src ? this._walk(src) : null;
    if (this.paths.size >= PATH_CACHE_LIMIT) this.paths.clear();
    this.paths.set(key, path);
    return path;
  }

  /** Follow the crack: a gently curving line with a tapering width, jagged by skipped steps and per-step jitter. */
  _walk(src) {
    const rng = src.rng;
    const length = rng.nextIntRange(RAVINE_MIN_LENGTH, RAVINE_MAX_LENGTH);
    const width = rng.nextRange(RAVINE_MIN_RADIUS, RAVINE_MAX_RADIUS);
    const depth = rng.nextIntRange(RAVINE_MIN_DEPTH, RAVINE_MAX_DEPTH);
    const yaw0 = rng.next() * Math.PI * 2;
    const top = src.surface + 3;
    const bottom = Math.max(MIN_CAVE_Y + 4, src.surface - depth);
    const yMid = (top + bottom) / 2, halfHeight = (top - bottom) / 2;
    const walk = new Random(rng.nextUint32());
    let x = src.x + 0.5, z = src.z + 0.5, yaw = yaw0, yawDelta = 0;
    const discs = [];
    for (let step = 0; step < length; step++) {
      const taper = 0.55 + Math.sin((step * Math.PI) / length) * 0.45;
      const r = Math.max(1.2, width * taper * (0.85 + walk.next() * 0.3));
      const rv = halfHeight * (0.75 + Math.sin((step * Math.PI) / length) * 0.3);
      x += Math.cos(yaw); z += Math.sin(yaw);
      yawDelta = yawDelta * 0.8 + (walk.next() - walk.next()) * walk.next() * 1.2;
      yaw += yawDelta * 0.1;
      yaw = yaw0 + clamp(yaw - yaw0, -1.0, 1.0); // a long crack, not a spiral
      if (walk.nextInt(5) === 0) continue;       // skipped steps leave jagged walls
      discs.push({ x, y: yMid, z, r, rv });
    }
    return discs;
  }

  /**
   * Carve every ravine that crosses this chunk.
   * @param {Uint8Array} blocks
   * @param {Int16Array} heights 16×16 terrain heights (only land columns above sea level + 2 are cut)
   */
  carve(blocks, cx, cz, heights) {
    const minX = cx * 16, minZ = cz * 16, maxX = minX + 15, maxZ = minZ + 15;
    const active = this.activeDiscs;
    active.length = 0;
    this.activeCX = cx; this.activeCZ = cz;
    for (let scx = cx - RANGE; scx <= cx + RANGE; scx++) {
      for (let scz = cz - RANGE; scz <= cz + RANGE; scz++) {
        const discs = this.path(scx, scz);
        if (!discs) continue;
        for (const d of discs) {
          if (d.x + d.r < minX - 4 || d.x - d.r > maxX + 4 || d.z + d.r < minZ - 4 || d.z - d.r > maxZ + 4) continue;
          active.push(d);
          if (d.x + d.r < minX - 1 || d.x - d.r > maxX + 1 || d.z + d.r < minZ - 1 || d.z - d.r > maxZ + 1) continue;
          this._carveDisc(blocks, heights, minX, minZ, d);
        }
      }
    }
  }

  _carveDisc(blocks, heights, minX, minZ, d) {
    const x0 = Math.max(Math.floor(d.x - d.r), minX), x1 = Math.min(Math.floor(d.x + d.r), minX + 15);
    const z0 = Math.max(Math.floor(d.z - d.r), minZ), z1 = Math.min(Math.floor(d.z + d.r), minZ + 15);
    for (let bx = x0; bx <= x1; bx++) {
      const ddx = (bx + 0.5 - d.x) / d.r;
      for (let bz = z0; bz <= z1; bz++) {
        const ddz = (bz + 0.5 - d.z) / d.r;
        const dd = ddx * ddx + ddz * ddz;
        if (dd >= 1) continue;
        const col = (bx - minX) + ((bz - minZ) << 4);
        if (heights[col] < RAVINE_MIN_SURFACE) continue; // never into oceans, rivers or beaches
        // A U-shaped floor: full depth along the centre line, shallower toward the walls.
        const k = Math.sqrt(1 - dd);
        const yLo = Math.max(MIN_CAVE_Y, Math.floor(d.y - d.rv * (0.3 + 0.7 * k)));
        const yHi = Math.min(255, Math.floor(d.y + d.rv));
        for (let y = yLo; y <= yHi; y++) {
          const i = col + (y << 8);
          const id = blocks[i];
          if (id === B.BEDROCK || id === B.AIR || isWater(id)) continue;
          blocks[i] = B.AIR;
        }
      }
    }
  }

  /**
   * Is the surface of world column (x, z) cut by a ravine? Tree placement asks this for columns within a few
   * blocks of the chunk being generated, so the discs collected by the last carve() of that chunk suffice;
   * other columns fall back to the full (cached) path scan.
   */
  surfaceCarved(x, z, surface) {
    const cx = x >> 4, cz = z >> 4;
    const near = this.activeCX !== null && Math.abs(cx - this.activeCX) <= 1 && Math.abs(cz - this.activeCZ) <= 1
      && x >= this.activeCX * 16 - 4 && x <= this.activeCX * 16 + 19 && z >= this.activeCZ * 16 - 4 && z <= this.activeCZ * 16 + 19;
    const test = (d) => { const ddx = (x + 0.5 - d.x) / d.r, ddz = (z + 0.5 - d.z) / d.r; return ddx * ddx + ddz * ddz < 1 && surface <= d.y + d.rv && surface >= d.y - d.rv; };
    if (near) { for (const d of this.activeDiscs) if (test(d)) return true; return false; }
    for (let scx = cx - RANGE; scx <= cx + RANGE; scx++) {
      for (let scz = cz - RANGE; scz <= cz + RANGE; scz++) {
        const discs = this.path(scx, scz);
        if (!discs) continue;
        for (const d of discs) if (test(d)) return true;
      }
    }
    return false;
  }
}
