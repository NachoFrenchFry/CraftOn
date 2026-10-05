// WorldGenerator.js — orchestrates all generation passes for one chunk, in order:
// terrain → surface/bedrock → caves → water → ores → decorations. Deterministic per (seed, cx, cz).
// Worker-safe; also usable on the main thread (e.g. for spawn finding).

import { SEA_LEVEL, BLOCKS_PER_CHUNK, WORLD_HEIGHT, MIN_CAVE_Y, CHEESE_TOP_Y, CAVE_SPRING_MIN, CAVE_SPRING_MAX, CAVE_SPRING_CAVERN_BLOCKS } from '../config/Constants.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { TerrainShaper, createColumnSample } from './TerrainShaper.js';
import { BiomeProvider } from './BiomeProvider.js';
import { SurfaceBuilder, MARGIN, HM_SIZE } from './SurfaceBuilder.js';
import { CaveCarver } from './CaveCarver.js';
import { NoiseCaves } from './NoiseCaves.js';
import { OreGenerator } from './OreGenerator.js';
import { RavineCarver } from './RavineCarver.js';
import { Decorator } from './Decorator.js';
import { BiomeIds, BIOMES } from './Biomes.js';
import { SimplexNoise } from '../utils/noise/SimplexNoise.js';
import { deriveSeed, chunkRandom } from '../utils/Random.js';
import { fieldOffset } from './NoiseOffsets.js';
import { isWater } from '../world/WaterLevels.js';

const SPRING_SALT = 0x5b12;

export class WorldGenerator {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.shaper = new TerrainShaper(this.seed);
    this.biomes = new BiomeProvider(this.seed, this.shaper);
    this.surface = new SurfaceBuilder(this.seed);
    this.caves = new CaveCarver(this.seed);
    this.noiseCaves = new NoiseCaves(this.seed);
    this.ores = new OreGenerator(this.seed);
    this.ravines = new RavineCarver(this.seed, this.shaper);
    this.decorator = new Decorator(this.seed, this.shaper, this.biomes, this.ravines);
    this.cliffMask = new Uint8Array(256);
    this.mossNoise = new SimplexNoise(deriveSeed(this.seed, 31));
    this.mossOff = fieldOffset(this.seed, 31);
    this.heights = new Int16Array(HM_SIZE * HM_SIZE);
    this.biomeIds = new Uint8Array(HM_SIZE * HM_SIZE);
    this.carveMaxY = new Int16Array(256);
    this.heightMap16 = new Int16Array(256);
    this._sample = createColumnSample();
  }

  /**
   * Generate a chunk.
   * @returns {{blocks:Uint8Array, heightMap:Uint8Array, biomeMap:Uint8Array}}
   */
  generateChunk(cx, cz) {
    this.shaper.resetCache();
    const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
    const heights = this.heights, biomeIds = this.biomeIds;
    const wx0 = cx * 16, wz0 = cz * 16;
    let maxHeight = 0;
    let hasMountains = false;

    // 1. Terrain heights and biomes for the chunk plus a 2-block margin.
    for (let z = 0; z < HM_SIZE; z++) {
      for (let x = 0; x < HM_SIZE; x++) {
        const s = this.shaper.sample(wx0 + x - MARGIN, wz0 + z - MARGIN, this._sample);
        const i = x + z * HM_SIZE;
        heights[i] = s.height;
        biomeIds[i] = this.biomes.classify(s);
        if (x >= MARGIN && x < MARGIN + 16 && z >= MARGIN && z < MARGIN + 16) {
          if (s.height > maxHeight) maxHeight = s.height;
          if (biomeIds[i] === BiomeIds.MOUNTAINS) hasMountains = true;
        }
      }
    }

    // 2. Surface layers and bedrock (also fills stone).
    this.surface.build(blocks, heights, biomeIds, cx, cz);

    // 3. Caves, protected near water: no carving within 4 blocks below any nearby ocean floor.
    const heightMap = new Uint8Array(256);
    const biomeMap = new Uint8Array(256);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const col = lx + (lz << 4);
        const hi = (lx + MARGIN) + (lz + MARGIN) * HM_SIZE;
        let minH = heights[hi];
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const h = heights[hi + dx + dz * HM_SIZE];
            if (h < minH) minH = h;
          }
        }
        this.carveMaxY[col] = minH <= SEA_LEVEL ? minH - 4 : WORLD_HEIGHT - 1;
        this.heightMap16[col] = heights[hi];
        heightMap[col] = heights[hi];
        biomeMap[col] = biomeIds[hi];
        // Steep high mountain faces get overhangs and notches from the coarse 3D noise (Update #8).
        const h = heights[hi];
        const dh = Math.max(Math.abs(h - heights[hi - 1]), Math.abs(h - heights[hi + 1]), Math.abs(h - heights[hi - HM_SIZE]), Math.abs(h - heights[hi + HM_SIZE]));
        this.cliffMask[col] = biomeIds[hi] === BiomeIds.MOUNTAINS && h >= 100 && dh >= 4 ? 1 : 0;
      }
    }
    this.caves.carve(blocks, cx, cz, this.carveMaxY);
    const carved = this.noiseCaves.carve(blocks, cx, cz, this.carveMaxY, maxHeight, this.heightMap16, this.cliffMask);
    const cheeseBlocks = carved && carved.cheeseBlocks ? carved.cheeseBlocks : 0;
    // Ravines: long deep cracks opening at the surface (land only; see RavineCarver.js).
    this.ravines.carve(blocks, cx, cz, this.heightMap16);
    this._fixExposedSurface(blocks, biomeMap);
    this._mossyCaveWalls(blocks, cx, cz);

    // 4. Water below sea level (only above the terrain surface, never inside sealed caves).
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const col = lx + (lz << 4);
        const h = heightMap[col];
        if (h >= SEA_LEVEL) continue;
        const freeze = BIOMES[biomeMap[col]].id === BiomeIds.OCEAN && this._isCold(wx0 + lx, wz0 + lz);
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          const i = col + (y << 8);
          if (blocks[i] === B.AIR) blocks[i] = (freeze && y === SEA_LEVEL) ? B.ICE : B.WATER;
        }
      }
    }

    // 5. Ores and dirt/gravel pockets, then exposed ore clusters on cave walls.
    this.ores.generate(blocks, cx, cz, hasMountains);
    this.ores.exposeOres(blocks, cx, cz, heightMap);
    // Cave springs: single water sources in the walls of big caverns (scheduled to flow when the chunk loads).
    const springs = this._caveSprings(blocks, cx, cz, heightMap, cheeseBlocks);

    // 6. Trees, plants and other decorations.
    this.decorator.decorate(blocks, cx, cz, biomeMap, this.heightMap16);

    // 7. Safety: no air or water may touch bedrock, so bedrock is never visible from caves.
    this._sealBedrock(blocks);

    return { blocks, heightMap, biomeMap, springs };
  }

  /**
   * 1–3 water source blocks inside cave walls of a chunk that holds a big cavern. A spring sits in stone
   * with solid blocks above and below (never in a ceiling or on a floor), touches cave air on at least one
   * horizontal side so it can pour out, is never within 2 blocks of other water, and is deterministic.
   * @returns {Int16Array} flat [lx, y, lz, ...]
   */
  _caveSprings(blocks, cx, cz, heightMap, cheeseBlocks) {
    if (cheeseBlocks < CAVE_SPRING_CAVERN_BLOCKS) return new Int16Array(0);
    const rng = chunkRandom(this.seed, cx, cz, SPRING_SALT);
    const want = CAVE_SPRING_MIN + rng.nextInt(CAVE_SPRING_MAX - CAVE_SPRING_MIN + 1);
    const out = [];
    const yLo = MIN_CAVE_Y + 3, yHi = CHEESE_TOP_Y + 8;
    for (let tries = 0; tries < 120 && out.length < want; tries++) {
      const lx = 1 + rng.nextInt(14), lz = 1 + rng.nextInt(14), y = yLo + rng.nextInt(yHi - yLo);
      const col = lx + (lz << 4);
      if (y >= heightMap[col] - 3) continue;
      const i = col + (y << 8);
      if (blocks[i] !== B.STONE) continue;
      if (blocks[i - 256] === B.AIR || blocks[i + 256] === B.AIR) continue; // not a ceiling or floor block
      const open = blocks[i - 1] === B.AIR || blocks[i + 1] === B.AIR || blocks[i - 16] === B.AIR || blocks[i + 16] === B.AIR;
      if (!open) continue;
      let nearWater = false;
      for (let dy = -2; dy <= 2 && !nearWater; dy++) for (let dz = -2; dz <= 2 && !nearWater; dz++) for (let dx = -2; dx <= 2; dx++) {
        const x = lx + dx, z = lz + dz, yy = y + dy;
        if (x < 0 || x > 15 || z < 0 || z > 15 || yy < 0 || yy > 255) continue;
        if (isWater(blocks[x + (z << 4) + (yy << 8)])) { nearWater = true; break; }
      }
      if (nearWater) continue;
      blocks[i] = B.WATER;
      out.push(lx, y, lz);
    }
    return Int16Array.from(out);
  }

  /** Turn any air/water block in y = 0..MIN_CAVE_Y that touches bedrock on one of its 6 sides into stone. */
  _sealBedrock(blocks) {
    for (let y = 0; y <= MIN_CAVE_Y; y++) {
      for (let col = 0; col < 256; col++) {
        const i = col + (y << 8);
        const id = blocks[i];
        if (id !== B.AIR && id !== B.WATER) continue;
        const lx = col & 15, lz = col >> 4;
        const touches = (y > 0 && blocks[i - 256] === B.BEDROCK) || blocks[i + 256] === B.BEDROCK
          || (lx > 0 && blocks[i - 1] === B.BEDROCK) || (lx < 15 && blocks[i + 1] === B.BEDROCK)
          || (lz > 0 && blocks[i - 16] === B.BEDROCK) || (lz < 15 && blocks[i + 16] === B.BEDROCK);
        if (touches) blocks[i] = B.STONE;
      }
    }
  }

  _isCold(x, z) {
    return this.shaper.sample(x, z, this._sample).temperature < -0.45;
  }

  /** Occasional mossy cobblestone patches on stone that faces cave air, deep underground. */
  _mossyCaveWalls(blocks, cx, cz) {
    const wx0 = cx * 16, wz0 = cz * 16;
    for (let y = MIN_CAVE_Y + 1; y < 50; y++) {
      for (let col = 0; col < 256; col++) {
        const i = col + (y << 8);
        if (blocks[i] !== B.STONE) continue;
        const lx = col & 15, lz = col >> 4;
        const nearAir = blocks[i + 256] === B.AIR || blocks[i - 256] === B.AIR
          || (lx > 0 && blocks[i - 1] === B.AIR) || (lx < 15 && blocks[i + 1] === B.AIR)
          || (lz > 0 && blocks[i - 16] === B.AIR) || (lz < 15 && blocks[i + 16] === B.AIR);
        if (!nearAir) continue;
        if (this.mossNoise.noise3D((wx0 + lx + this.mossOff[0]) / 9, y / 9, (wz0 + lz + this.mossOff[2]) / 9) > 0.55) blocks[i] = B.MOSSY_COBBLESTONE;
      }
    }
  }

  /** Where a cave removed the surface, turn newly exposed dirt into grass (Minecraft does this). */
  _fixExposedSurface(blocks, biomeMap) {
    for (let col = 0; col < 256; col++) {
      const h = this.heightMap16[col];
      if (blocks[col + (h << 8)] !== B.AIR) continue;
      const top = BIOMES[biomeMap[col]].top;
      if (top !== B.GRASS_BLOCK && top !== B.SNOWY_GRASS) continue;
      for (let y = h - 1; y > h - 6 && y > 0; y--) {
        const i = col + (y << 8);
        const id = blocks[i];
        if (id === B.AIR) continue;
        if (id === B.DIRT) blocks[i] = top;
        break;
      }
    }
  }

  /** Terrain height (before caves) at a world column — for spawn finding on the main thread. */
  surfaceHeight(x, z) {
    return this.shaper.sample(x, z, this._sample).height;
  }

  biomeAt(x, z) {
    return this.biomes.classify(this.shaper.sample(x, z, this._sample));
  }
}
