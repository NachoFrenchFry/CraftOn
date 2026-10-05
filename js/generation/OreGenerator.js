// OreGenerator.js — ore veins (Minecraft's "ellipsoid along a line" method) plus dirt/gravel pockets,
// and an exposed-ore pass that seeds small clusters on stone facing cave air so cavern walls show ore.
// Veins only replace stone; counts per chunk are deterministic. Worker-safe.

import { chunkRandom } from '../utils/Random.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { MIN_CAVE_Y } from '../config/Constants.js';

const SALT = 0x0ec5;
const EXPOSED_SALT = 0x0e05;

/** Vein table: block, min/max y, veins per chunk, vein size range. */
export const ORE_TABLE = [
  { block: B.DIRT, minY: 1, maxY: 250, count: 6, sizeMin: 20, sizeMax: 32, pocket: true },
  { block: B.GRAVEL, minY: 1, maxY: 250, count: 4, sizeMin: 20, sizeMax: 32, pocket: true },
  { block: B.COAL_ORE, minY: 5, maxY: 128, count: 20, sizeMin: 8, sizeMax: 16 },
  { block: B.IRON_ORE, minY: 5, maxY: 64, count: 12, sizeMin: 4, sizeMax: 9 },
  { block: B.GOLD_ORE, minY: 5, maxY: 32, count: 3, sizeMin: 4, sizeMax: 9 },
  { block: B.DIAMOND_ORE, minY: 5, maxY: 16, count: 2, sizeMin: 3, sizeMax: 6 },
];

/**
 * Exposed-ore table: for every stone block that faces cave air below the surface, `chance` is the
 * probability of starting a cluster of this ore there (checked in order, depth permitting).
 */
export const EXPOSED_ORE_TABLE = [
  { block: B.COAL_ORE, maxY: 128, chance: 0.0040, sizeMin: 2, sizeMax: 5 },
  { block: B.IRON_ORE, maxY: 64, chance: 0.0050, sizeMin: 2, sizeMax: 4 },
  { block: B.GOLD_ORE, maxY: 32, chance: 0.0020, sizeMin: 1, sizeMax: 3 },
  { block: B.DIAMOND_ORE, maxY: 16, chance: 0.0009, sizeMin: 1, sizeMax: 2 },
];
const STEPS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class OreGenerator {
  constructor(seed) {
    this.seed = seed;
  }

  /**
   * @param {Uint8Array} blocks
   * @param {boolean} hasMountains whether any column of the chunk is in the mountains biome
   */
  generate(blocks, cx, cz, hasMountains) {
    const rng = chunkRandom(this.seed, cx, cz, SALT);
    for (const ore of ORE_TABLE) {
      for (let i = 0; i < ore.count; i++) {
        const x = rng.nextInt(16);
        const y = rng.nextIntRange(ore.minY, ore.maxY);
        const z = rng.nextInt(16);
        const size = rng.nextIntRange(ore.sizeMin, ore.sizeMax);
        if (ore.mountainsOnly && !hasMountains) continue;
        if (size <= 1) {
          const idx = x + (z << 4) + (y << 8);
          if (blocks[idx] === B.STONE) blocks[idx] = ore.block;
          continue;
        }
        this._vein(blocks, rng, x, y, z, size, ore.block, ore.maxY);
      }
    }
  }

  /**
   * Exposed-ore pass (after carving and the vein pass): stone touching cave air below the surface may
   * start a small cluster, so walking through caverns shows coal / iron on the walls and, deeper down,
   * gold and the occasional diamond. Deterministic per chunk.
   * @param {Uint8Array} heightMap terrain height per column (16×16)
   */
  exposeOres(blocks, cx, cz, heightMap) {
    const rng = chunkRandom(this.seed, cx, cz, EXPOSED_SALT);
    for (let y = MIN_CAVE_Y + 1; y < 128; y++) {
      for (let col = 0; col < 256; col++) {
        if (y >= heightMap[col] - 2) continue; // stay below the surface layers
        const i = col + (y << 8);
        if (blocks[i] !== B.STONE) continue;
        const lx = col & 15, lz = col >> 4;
        const exposed = blocks[i + 256] === B.AIR || blocks[i - 256] === B.AIR
          || (lx > 0 && blocks[i - 1] === B.AIR) || (lx < 15 && blocks[i + 1] === B.AIR)
          || (lz > 0 && blocks[i - 16] === B.AIR) || (lz < 15 && blocks[i + 16] === B.AIR);
        if (!exposed) continue;
        const roll = rng.next();
        let acc = 0;
        for (const ore of EXPOSED_ORE_TABLE) {
          if (y > ore.maxY) continue;
          acc += ore.chance;
          if (roll < acc) { this._cluster(blocks, rng, lx, y, lz, rng.nextIntRange(ore.sizeMin, ore.sizeMax), ore.block, ore.maxY); break; }
        }
      }
    }
  }

  /** Small cluster: a random walk over neighbouring stone, preferring blocks that also face air. */
  _cluster(blocks, rng, x, y, z, size, block, maxY = 127) {
    let placed = 0;
    for (let n = 0; n < size * 3 && placed < size; n++) {
      const i = x + (z << 4) + (y << 8);
      if (blocks[i] === B.STONE || blocks[i] === block) { if (blocks[i] === B.STONE) placed++; blocks[i] = block; }
      // Try a couple of directions, keeping the one that stays in stone next to air.
      let nx = x, ny = y, nz = z;
      for (let attempt = 0; attempt < 3; attempt++) {
        const [dx, dy, dz] = STEPS[rng.nextInt(6)];
        const tx = x + dx, ty = y + dy, tz = z + dz;
        if (tx < 0 || tx > 15 || tz < 0 || tz > 15 || ty <= MIN_CAVE_Y || ty > maxY) continue;
        const ti = tx + (tz << 4) + (ty << 8);
        if (blocks[ti] !== B.STONE) continue;
        nx = tx; ny = ty; nz = tz;
        const facesAir = blocks[ti + 256] === B.AIR || blocks[ti - 256] === B.AIR
          || (tx > 0 && blocks[ti - 1] === B.AIR) || (tx < 15 && blocks[ti + 1] === B.AIR)
          || (tz > 0 && blocks[ti - 16] === B.AIR) || (tz < 15 && blocks[ti + 16] === B.AIR);
        if (facesAir) break;
      }
      if (nx === x && ny === y && nz === z) break;
      x = nx; y = ny; z = nz;
    }
  }

  _vein(blocks, rng, x, y, z, size, block, maxY = 250) {
    const angle = rng.next() * Math.PI;
    const x1 = x + 8 + Math.sin(angle) * size / 8, x2 = x + 8 - Math.sin(angle) * size / 8;
    const z1 = z + 8 + Math.cos(angle) * size / 8, z2 = z + 8 - Math.cos(angle) * size / 8;
    const y1 = y + rng.nextInt(3) - 2, y2 = y + rng.nextInt(3) - 2;
    for (let k = 0; k <= size; k++) {
      const t = k / size;
      const cx = x1 + (x2 - x1) * t - 8;
      const cy = y1 + (y2 - y1) * t;
      const cz = z1 + (z2 - z1) * t - 8;
      const scale = rng.next() * size / 16;
      const hr = (Math.sin(Math.PI * t) + 1) * scale + 1;
      const vr = (Math.sin(Math.PI * t) + 1) * scale + 1;
      const bx0 = Math.max(0, Math.floor(cx - hr / 2)), bx1 = Math.min(15, Math.floor(cx + hr / 2));
      const by0 = Math.max(1, Math.floor(cy - vr / 2)), by1 = Math.min(maxY, Math.floor(cy + vr / 2));
      const bz0 = Math.max(0, Math.floor(cz - hr / 2)), bz1 = Math.min(15, Math.floor(cz + hr / 2));
      for (let bx = bx0; bx <= bx1; bx++) {
        const dx = (bx + 0.5 - cx) / (hr / 2);
        if (dx * dx >= 1) continue;
        for (let by = by0; by <= by1; by++) {
          const dy = (by + 0.5 - cy) / (vr / 2);
          if (dx * dx + dy * dy >= 1) continue;
          for (let bz = bz0; bz <= bz1; bz++) {
            const dz = (bz + 0.5 - cz) / (hr / 2);
            if (dx * dx + dy * dy + dz * dz >= 1) continue;
            const i = bx + (bz << 4) + (by << 8);
            if (blocks[i] === B.STONE) blocks[i] = block;
          }
        }
      }
    }
  }
}

