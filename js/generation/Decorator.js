// Decorator.js — trees (cross-chunk safe), tall grass, flowers, cacti and dead bushes.
// Trees of the 3×3 neighbouring chunks are enumerated deterministically; only the blocks that fall
// inside the current chunk are written. Trees never stand on one-block-wide peaks or on columns a ravine
// cuts open (Update #8), so none float. Worker-safe.

import { chunkRandom } from '../utils/Random.js';
import { SEA_LEVEL, WORLD_HEIGHT } from '../config/Constants.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { SOLID } from '../blocks/BlockRegistry.js';
import { BIOMES, isTreeSoil } from './Biomes.js';
import { buildTree, buildCactus, TREE_MAX_RADIUS, TREE_MAX_HEIGHT } from './TreeGenerator.js';
import { createColumnSample } from './TerrainShaper.js';
import { STEEP_SLOPE } from './SurfaceBuilder.js';

const SALT_TREES = 0x7ee5;
const SALT_PLANTS = 0x91a7;
const TREE_ATTEMPTS = 10;
const TREE_MIN_SPACING = 3;
/** A column whose four neighbours are all lower, with a drop of at least this much somewhere: a peak, no tree. */
const PEAK_DROP = 2;

export class Decorator {
  /**
   * @param {import('./TerrainShaper.js').TerrainShaper} shaper
   * @param {import('./BiomeProvider.js').BiomeProvider} biomes
   */
  /** @param {import('./RavineCarver.js').RavineCarver} [ravines] */
  constructor(seed, shaper, biomes, ravines = null) {
    this.seed = seed;
    this.shaper = shaper;
    this.biomes = biomes;
    this.ravines = ravines;
    this._sample = createColumnSample();
  }

  /** Deterministic tree specs for a chunk (pure function of seed, chunk coords and terrain). */
  treeCandidates(cx, cz) {
    const rng = chunkRandom(this.seed, cx, cz, SALT_TREES);
    const specs = [];
    for (let i = 0; i < TREE_ATTEMPTS; i++) {
      const lx = rng.nextInt(16), lz = rng.nextInt(16);
      const roll = rng.next();
      const typeRoll = rng.next();
      const seed = rng.nextUint32();
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      const s = this.shaper.sample(wx, wz, this._sample);
      const biome = BIOMES[this.biomes.classify(s)];
      if (biome.treeDensity <= 0 || roll >= biome.treeDensity) continue;
      if (s.height < SEA_LEVEL + 1 || !isTreeSoil(biome.top)) continue;
      const h = s.height;
      const n = [this.shaper.heightAt(wx + 1, wz), this.shaper.heightAt(wx - 1, wz), this.shaper.heightAt(wx, wz + 1), this.shaper.heightAt(wx, wz - 1)];
      const steep = Math.max(Math.abs(h - n[0]), Math.abs(h - n[1]), Math.abs(h - n[2]), Math.abs(h - n[3])) >= STEEP_SLOPE;
      if (steep) continue;
      // One-block-wide peak (every neighbour lower, one of them by PEAK_DROP or more): the tree would stand on a spike.
      if (n.every((v) => v < h) && n.some((v) => h - v >= PEAK_DROP)) continue;
      if (this.ravines && this.ravines.surfaceCarved(wx, wz, h)) continue; // the ground will be cut away
      let tooClose = false;
      for (const o of specs) {
        if (Math.abs(o.x - wx) < TREE_MIN_SPACING && Math.abs(o.z - wz) < TREE_MIN_SPACING) { tooClose = true; break; }
      }
      if (tooClose) continue;
      const type = biome.treeTypes[Math.floor(typeRoll * biome.treeTypes.length)];
      specs.push({ x: wx, y: h + 1, z: wz, type, seed });
    }
    return specs;
  }

  /**
   * @param {Uint8Array} blocks
   * @param {Uint8Array} biomeMap 16×16 biome ids
   * @param {Int16Array} heightMap16 16×16 terrain heights
   */
  decorate(blocks, cx, cz, biomeMap, heightMap16) {
    const wx0 = cx * 16, wz0 = cz * 16;
    const write = (wx, wy, wz, id, isTrunk) => {
      const lx = wx - wx0, lz = wz - wz0;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || wy < 1 || wy >= WORLD_HEIGHT) return;
      const i = lx + (lz << 4) + (wy << 8);
      const cur = blocks[i];
      if (isTrunk) {
        if (cur === B.AIR || cur === B.LEAVES || !SOLID[cur]) blocks[i] = id;
      } else if (cur === B.AIR || !SOLID[cur]) {
        blocks[i] = id;
      }
    };

    // Trees from this chunk and its 8 neighbours.
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcz = -1; dcz <= 1; dcz++) {
        const specs = this.treeCandidates(cx + dcx, cz + dcz);
        for (const spec of specs) {
          if (spec.x + TREE_MAX_RADIUS < wx0 || spec.x - TREE_MAX_RADIUS > wx0 + 15) continue;
          if (spec.z + TREE_MAX_RADIUS < wz0 || spec.z - TREE_MAX_RADIUS > wz0 + 15) continue;
          buildTree(spec, write);
          // Dirt under the trunk, like Minecraft.
          const lx = spec.x - wx0, lz = spec.z - wz0;
          if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) {
            const gi = lx + (lz << 4) + ((spec.y - 1) << 8);
            if (blocks[gi] === B.GRASS_BLOCK || blocks[gi] === B.SNOWY_GRASS) blocks[gi] = B.DIRT;
          }
        }
      }
    }

    // Plants, cacti, dead bushes (single-column features).
    const rng = chunkRandom(this.seed, cx, cz, SALT_PLANTS);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const col = lx + (lz << 4);
        const biome = BIOMES[biomeMap[col]];
        const h = heightMap16[col];
        if (h < SEA_LEVEL + 1 || h + 1 >= WORLD_HEIGHT) continue;
        const ground = blocks[col + (h << 8)];
        const above = col + ((h + 1) << 8);
        if (blocks[above] !== B.AIR) continue;
        const roll = rng.next();
        if (ground === B.GRASS_BLOCK || ground === B.SNOWY_GRASS) {
          if (roll < biome.flowerDensity) blocks[above] = rng.chance(0.5) ? B.FLOWER_RED : B.FLOWER_YELLOW;
          else if (roll < biome.flowerDensity + biome.grassDensity) blocks[above] = B.GRASS;
        } else if (ground === B.SAND) {
          if (roll < biome.cactusDensity && lx > 0 && lx < 15 && lz > 0 && lz < 15 && this._cactusRoom(blocks, lx, h + 1, lz)) {
            buildCactus(wx0 + lx, h + 1, wz0 + lz, rng, write);
          } else if (roll < biome.cactusDensity + biome.deadBushDensity) {
            blocks[above] = B.DEAD_BUSH;
          }
        }
      }
    }
  }

  _cactusRoom(blocks, lx, y, lz) {
    for (let dy = 0; dy < 3; dy++) {
      const yy = y + dy;
      if (yy >= WORLD_HEIGHT) return false;
      if (blocks[(lx + 1) + (lz << 4) + (yy << 8)] !== B.AIR) return false;
      if (blocks[(lx - 1) + (lz << 4) + (yy << 8)] !== B.AIR) return false;
      if (blocks[lx + ((lz + 1) << 4) + (yy << 8)] !== B.AIR) return false;
      if (blocks[lx + ((lz - 1) << 4) + (yy << 8)] !== B.AIR) return false;
    }
    return true;
  }
}

