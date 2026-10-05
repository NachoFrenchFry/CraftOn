// NoiseCaves.js — modern-style noise caves (Caves & Cliffs flavour): two spaghetti tunnel layers at
// different scales, thin noodle caves (sharing a field with the second layer), and huge cheese caverns
// with stone pillars from two independent cavern fields (twice as many caverns, same sizes). Every 3D field is
// sampled on a coarse 4-block grid; each column then interpolates the grid bilinearly once per layer
// and only lerps vertically per block, testing the cheap fields first. Pillar columns are restored to
// solid stone over the cavern's full height after every carver ran (the worm carver runs first), and
// a pillar that would not reach both the floor and the ceiling is carved away instead of left as a stub.
// Worker-safe.

import { SimplexNoise } from '../utils/noise/SimplexNoise.js';
import { deriveSeed } from '../utils/Random.js';
import { fieldOffset } from './NoiseOffsets.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { MIN_CAVE_Y, SPAGHETTI_THRESHOLD, SPAGHETTI2_THRESHOLD, NOODLE_THRESHOLD, CHEESE_THRESHOLD, CHEESE_TOP_Y, PILLAR_THRESHOLD } from '../config/Constants.js';

const H_STEP = 4;
const V_STEP = 4;
const GX = 16 / H_STEP + 1; // samples per horizontal axis
const MAX_GY = 70;
// Field scales (x/z, y).
const SPAGHETTI = [1 / 60, 1 / 40];
const SPAGHETTI2 = [1 / 40, 1 / 28];
const NOODLE = [1 / 25, 1 / 20];
const CHEESE = [1 / 96, 1 / 56];
const PILLAR_SCALE = 1 / 14; // 2D: pillars run straight from the cavern floor to its ceiling
const FIELDS = 7; // A, B, A2, B2, N, C, C2
const F_A = 0, F_B = 1, F_A2 = 2, F_B2 = 3, F_N = 4, F_C = 5, F_C2 = 6;
/** Tunnel and noodle caves stop here; above it only the cliff field (A2) is sampled, so tall peaks stay cheap (Update #8). */
export const CAVE_TOP_Y = 150;

export class NoiseCaves {
  constructor(seed) {
    this.noises = [];
    for (let i = 0; i < FIELDS; i++) this.noises.push(new SimplexNoise(deriveSeed(seed, 21 + i)));
    this.pillarNoise = new SimplexNoise(deriveSeed(seed, 21 + FIELDS));
    this.off = [];
    for (let i = 0; i <= FIELDS; i++) this.off.push(fieldOffset(seed, 21 + i)); // per-field origins (see NoiseOffsets.js)
    this.grid = new Float32Array(FIELDS * GX * GX * MAX_GY);
    this.pillarGrid = new Float32Array(GX * GX);
    this.colv = new Float32Array(FIELDS * (MAX_GY + 1)); // per-column bilinear values per grid layer
    /** Set to an array to record pillar decisions ({ col, y0, y1, keep }) — used by the Node check. */
    this.debugPillars = null;
  }

  /** Cheese cavern threshold: constant up to CHEESE_TOP_Y, then rising so caverns fade toward the surface. */
  static cheeseThreshold(y) {
    return CHEESE_THRESHOLD + Math.max(0, (y - CHEESE_TOP_Y) / 30) * 0.45;
  }

  _sample(field, x0, y0, z0) {
    const n = this.noises[field];
    const o = this.off[field];
    const x = x0 + o[0], y = y0 + o[1] * 0.001, z = z0 + o[2];
    switch (field) {
      case F_A: return n.noise3D(x * SPAGHETTI[0], y * SPAGHETTI[1], z * SPAGHETTI[0]);
      case F_B: return n.noise3D(x * SPAGHETTI[0] + 17.3, y * SPAGHETTI[1], z * SPAGHETTI[0] - 5.1);
      case F_A2: return n.noise3D(x * SPAGHETTI2[0], y * SPAGHETTI2[1], z * SPAGHETTI2[0]);
      case F_B2: return n.noise3D(x * SPAGHETTI2[0] - 9.7, y * SPAGHETTI2[1], z * SPAGHETTI2[0] + 3.3);
      case F_N: return n.noise3D(x * NOODLE[0], y * NOODLE[1], z * NOODLE[0]);
      case F_C: return n.noise3D(x * CHEESE[0], y * CHEESE[1], z * CHEESE[0]);
      default: return n.noise3D(x * CHEESE[0] + 41.7, y * CHEESE[1] + 3.3, z * CHEESE[0] - 23.9); // second cavern field
    }
  }

  /**
   * @param {Uint8Array} blocks
   * @param {Int16Array} carveMaxY per column (16×16)
   * @param {number} maxHeight highest terrain in the chunk
   * @param {Int16Array} [heights] 16×16 terrain heights (for the cliff notches)
   * @param {Uint8Array} [cliffMask] 16×16: 1 where steep high mountain faces may get overhangs / notches (Update #8)
   */
  carve(blocks, cx, cz, carveMaxY, maxHeight, heights = null, cliffMask = null) {
    const wx0 = cx * 16, wz0 = cz * 16;
    let cheeseBlocks = 0; // cavern volume carved in this chunk (springs use it to spot big caverns)
    const gy = Math.min(Math.floor(maxHeight / V_STEP) + 2, MAX_GY - 1);
    const iy0 = Math.floor(MIN_CAVE_Y / V_STEP);
    const grid = this.grid, stride = GX * GX * MAX_GY, pillarGrid = this.pillarGrid;
    // Above this height the cheese threshold exceeds any noise value, so C need not be sampled there.
    const cheeseMaxY = CHEESE_TOP_Y + 30 * (0.95 - CHEESE_THRESHOLD) / 0.45;
    // Coarse samples of every field.
    for (let iz = 0; iz < GX; iz++) {
      const z = wz0 + iz * H_STEP;
      for (let ix = 0; ix < GX; ix++) {
        const x = wx0 + ix * H_STEP;
        pillarGrid[ix + iz * GX] = this.pillarNoise.noise2D((x + this.off[FIELDS][0]) * PILLAR_SCALE, (z + this.off[FIELDS][2]) * PILLAR_SCALE);
        for (let iy = iy0; iy < gy; iy++) {
          const y = iy * V_STEP;
          const gi = ix + iz * GX + iy * GX * GX;
          if (y <= CAVE_TOP_Y + V_STEP) { for (let f = 0; f < F_C; f++) grid[f * stride + gi] = this._sample(f, x, y, z); }
          else { for (let f = 0; f < F_C; f++) grid[f * stride + gi] = f === F_A2 ? this._sample(f, x, y, z) : 1; } // no caves up here, only cliff notches
          const cheese = y <= cheeseMaxY + V_STEP;
          grid[F_C * stride + gi] = cheese ? this._sample(F_C, x, y, z) : -1;
          grid[F_C2 * stride + gi] = cheese ? this._sample(F_C2, x, y, z) : -1;
        }
      }
    }
    // Interpolate per column, then per block.
    const maxY = Math.min(maxHeight, (gy - 1) * V_STEP - 1);
    const colv = this.colv, CV = MAX_GY + 1;
    for (let lz = 0; lz < 16; lz++) {
      const iz = Math.floor(lz / H_STEP), fz = (lz % H_STEP) / H_STEP;
      for (let lx = 0; lx < 16; lx++) {
        const col = lx + (lz << 4);
        const top = Math.min(maxY, carveMaxY[col]);
        if (top < MIN_CAVE_Y) continue;
        const ix = Math.floor(lx / H_STEP), fx = (lx % H_STEP) / H_STEP;
        const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
        const c00 = ix + iz * GX, c10 = c00 + 1, c01 = c00 + GX, c11 = c01 + 1;
        const pillar = pillarGrid[c00] * w00 + pillarGrid[c10] * w10 + pillarGrid[c01] * w01 + pillarGrid[c11] * w11;
        const isPillar = pillar >= PILLAR_THRESHOLD;
        const cliff = cliffMask && cliffMask[col] === 1 ? heights[col] : -1;
        let rangeStart = -1; // start of the cavern height range at a pillar column
        const gyTop = Math.floor(top / V_STEP) + 1;
        for (let f = 0; f < FIELDS; f++) {
          const g = f * stride, cf = f * CV;
          for (let iy = iy0; iy <= gyTop; iy++) {
            const b = iy * GX * GX;
            colv[cf + iy] = grid[g + b + c00] * w00 + grid[g + b + c10] * w10 + grid[g + b + c01] * w01 + grid[g + b + c11] * w11;
          }
        }
        for (let y = MIN_CAVE_Y; y <= top; y++) {
          const iy = Math.floor(y / V_STEP), fy = (y % V_STEP) / V_STEP, fy0 = 1 - fy;
          const floorT = Math.min(1, (y - MIN_CAVE_Y + 1) / 4); // taper toward the cave floor
          let carve = false;
          const tS = SPAGHETTI_THRESHOLD * floorT;
          const a = colv[F_A * CV + iy] * fy0 + colv[F_A * CV + iy + 1] * fy;
          if (a < tS && a > -tS) {
            const b = colv[F_B * CV + iy] * fy0 + colv[F_B * CV + iy + 1] * fy;
            if (b < tS && b > -tS) carve = true; // spaghetti
          }
          if (!carve) {
            // Second spaghetti layer (A2, B2); noodles are the thin intersection of B2 with the small-scale N.
            const t2 = SPAGHETTI2_THRESHOLD * floorT;
            const b2 = colv[F_B2 * CV + iy] * fy0 + colv[F_B2 * CV + iy + 1] * fy;
            if (b2 < t2 && b2 > -t2) {
              const a2 = colv[F_A2 * CV + iy] * fy0 + colv[F_A2 * CV + iy + 1] * fy;
              if (a2 < t2 && a2 > -t2) carve = true;
              else {
                const tN = NOODLE_THRESHOLD * floorT;
                if (b2 < tN && b2 > -tN) {
                  const n = colv[F_N * CV + iy] * fy0 + colv[F_N * CV + iy + 1] * fy;
                  if (n < tN && n > -tN) carve = true;
                }
              }
            }
          }
          // Cliff faces: notches and overhangs just under the surface of steep mountain walls.
          if (!carve && cliff >= 0 && y >= cliff - 14 && y <= cliff - 2) {
            const a2 = colv[F_A2 * CV + iy] * fy0 + colv[F_A2 * CV + iy + 1] * fy;
            if (a2 > 0.42) carve = true;
          }
          let cheese = false;
          if (y <= cheeseMaxY) {
            const thr = NoiseCaves.cheeseThreshold(y) + (1 - floorT) * 0.5;
            const c = colv[F_C * CV + iy] * fy0 + colv[F_C * CV + iy + 1] * fy;
            if (c > thr) cheese = true;
            else {
              const c2 = colv[F_C2 * CV + iy] * fy0 + colv[F_C2 * CV + iy + 1] * fy;
              if (c2 > thr) cheese = true;
            }
          }
          if (cheese && !isPillar) { if (!carve) cheeseBlocks++; carve = true; } // cheese cavern minus pillars
          if (carve) {
            const i = col + (y << 8);
            const id = blocks[i];
            if (id !== B.BEDROCK && id !== B.WATER) blocks[i] = B.AIR;
          }
          if (isPillar) {
            if (cheese) { if (rangeStart < 0) rangeStart = y; }
            else if (rangeStart >= 0) { this._pillarColumn(blocks, col, rangeStart, y - 1); rangeStart = -1; }
          }
        }
        if (rangeStart >= 0) this._pillarColumn(blocks, col, rangeStart, top);
      }
    }
    return { cheeseBlocks };
  }

  /**
   * A pillar column over a cavern's height range [y0, y1]: when the block just below and just above the
   * range are solid (floor and ceiling exist) the range becomes solid stone, undoing every carver; when
   * either is missing the column is carved like the rest of the cavern so no partial stub is left.
   */
  _pillarColumn(blocks, col, y0, y1) {
    const solid = (id) => id !== B.AIR && id !== B.WATER;
    const below = y0 > 0 ? blocks[col + ((y0 - 1) << 8)] : B.BEDROCK;
    const above = y1 < 255 ? blocks[col + ((y1 + 1) << 8)] : B.AIR;
    const keep = solid(below) && solid(above);
    if (this.debugPillars) this.debugPillars.push({ col, y0, y1, keep });
    for (let y = y0; y <= y1; y++) {
      const i = col + (y << 8);
      const id = blocks[i];
      if (id === B.BEDROCK || id === B.WATER) continue;
      blocks[i] = keep ? B.STONE : B.AIR;
    }
  }
}
