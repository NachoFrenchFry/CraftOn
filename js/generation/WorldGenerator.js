// WorldGenerator.js — orchestrates all generation passes for one chunk, in order:
// terrain → surface/bedrock → caves → water → ores → decorations. Deterministic per (seed, cx, cz).
// Worker-safe; also usable on the main thread (e.g. for spawn finding).

import { SEA_LEVEL, BLOCKS_PER_CHUNK, WORLD_HEIGHT, MIN_CAVE_Y, CHEESE_TOP_Y, CAVE_SPRING_MIN, CAVE_SPRING_MAX, CAVE_SPRING_CAVERN_BLOCKS, LAVA_POOL_CAVERN_BLOCKS, LAVA_POOL_MAX_Y, LAVA_POOL_MAX_CELLS, LAVA_POOL_CHANCE, DESERT_LAKE_CHANCE } from '../config/Constants.js';
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
import { isWater, isLava } from '../world/WaterLevels.js';

const SPRING_SALT = 0x5b12;
const LAVA_SALT = 0x7a1c;
const LAKE_SALT = 0x3d9e;
const SOLID_FOR_LAVA = (id) => id !== B.AIR && !isWater(id) && !isLava(id) && id !== B.GRASS && id !== B.FLOWER_RED && id !== B.FLOWER_YELLOW && id !== B.FLOWER_BLUE && id !== B.DEAD_BUSH;

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
    // Lava lakes (Update #11): closed floor basins of big deep caverns.
    let lavaPools = this._lavaPools(blocks, cx, cz, heightMap, cheeseBlocks);

    // 6. Trees, plants and other decorations.
    this.decorator.decorate(blocks, cx, cz, biomeMap, this.heightMap16);
    // Rare desert lava lakes (after the plants, so the crater is clear of cacti and bushes).
    lavaPools += this._desertLake(blocks, cx, cz, heightMap, biomeMap);

    // 7. Safety: no air or water may touch bedrock, so bedrock is never visible from caves.
    this._sealBedrock(blocks);

    return { blocks, heightMap, biomeMap, springs, lavaPools };
  }

  /** Any water in the chunk within `r` blocks of (lx, y, lz) (chunk-local; the caller keeps pools off the chunk border). */
  _waterNear(blocks, lx, y, lz, r) {
    for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const x = lx + dx, z = lz + dz, yy = y + dy;
      if (x < 0 || x > 15 || z < 0 || z > 15 || yy < 0 || yy > 255) continue;
      if (isWater(blocks[x + (z << 4) + (yy << 8)])) return true;
    }
    return false;
  }

  /**
   * Lava pools (Update #11 §3e): in a chunk with a big cheese cavern, every cave-floor cell below LAVA_POOL_MAX_Y is a
   * candidate; a deterministic flood fill at its level collects the basin. A basin qualifies only when every cell
   * reached is air standing on a solid block (no step down anywhere, so nothing can pour out), the fill stays inside
   * lx / lz 1..14 (every horizontal neighbour at that level is solid and inside this chunk), it holds 3 to
   * LAVA_POOL_MAX_CELLS cells and no water lies within 3 blocks. The lowest one or two basins are filled with lava
   * sources, so everything sits still when the chunk loads. Returns the number of pools made.
   */
  _lavaPools(blocks, cx, cz, heightMap, cheeseBlocks) {
    if (cheeseBlocks < LAVA_POOL_CAVERN_BLOCKS) return 0;
    const rng = chunkRandom(this.seed, cx, cz, LAVA_SALT);
    if (!rng.chance(LAVA_POOL_CHANCE)) return 0;
    const want = 1 + rng.nextInt(2);
    let pools = 0;
    const tried = new Set();
    const stack = [];
    for (let y = MIN_CAVE_Y + 2; y <= LAVA_POOL_MAX_Y && pools < want; y++) {
      const yb = y << 8;
      for (let lz = 1; lz <= 14 && pools < want; lz++) for (let lx = 1; lx <= 14 && pools < want; lx++) {
        const col = lx + (lz << 4), i = col + yb;
        if (blocks[i] !== B.AIR || !SOLID_FOR_LAVA(blocks[i - 256]) || blocks[i + 256] !== B.AIR) continue; // a cave-floor cell
        if (y >= heightMap[col] - 6 || tried.has(i)) continue;
        // Flood fill the basin at this level. Air cells reached by an earlier (failed) fill at this level stay air, so
        // touching one of them means this basin is open too.
        const cells = [], seen = new Set([col]);
        let ok = true;
        stack.length = 0; stack.push(col); tried.add(i);
        while (stack.length) {
          const c = stack.pop();
          const x = c & 15, z = c >> 4;
          if (x < 1 || x > 14 || z < 1 || z > 14) { ok = false; continue; }         // reaches the chunk border: unknown neighbours
          if (!SOLID_FOR_LAVA(blocks[c + yb - 256])) { ok = false; continue; }      // a step down: lava would pour out
          cells.push(c);
          if (cells.length > LAVA_POOL_MAX_CELLS) ok = false;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nc = (x + dx) + ((z + dz) << 4), ni = nc + yb;
            if (seen.has(nc)) continue;
            const nid = blocks[ni];
            if (nid === B.AIR) { if (tried.has(ni)) ok = false; else { seen.add(nc); tried.add(ni); stack.push(nc); } }
            else if (!SOLID_FOR_LAVA(nid)) ok = false;                                // water or a plant beside the basin: skip it
          }
          if (!ok && cells.length > LAVA_POOL_MAX_CELLS * 2) break;                   // far too big: stop walking it
        }
        if (!ok || cells.length < 3) continue;
        for (const c of cells) if (this._waterNear(blocks, c & 15, y, c >> 4, 3)) { ok = false; break; }
        if (!ok) continue;
        for (const c of cells) blocks[c + yb] = B.LAVA;
        pools++;
      }
    }
    return pools;
  }

  /** Deterministic desert lake parameters for a chunk, or null: needs the whole chunk desert and a flat centre. */
  desertLakeParams(cx, cz, heightMap, biomeMap) {
    const rng = chunkRandom(this.seed, cx, cz, LAKE_SALT);
    if (!rng.chance(DESERT_LAKE_CHANCE)) return null;
    for (let col = 0; col < 256; col++) if (BIOMES[biomeMap[col]].id !== BiomeIds.DESERT) return null;
    const ccx = 7 + rng.nextInt(2), ccz = 7 + rng.nextInt(2);
    const rx = 2.5 + rng.next() * 2, rz = 2.5 + rng.next() * 2;   // 5–9 blocks across
    const depth = 2 + rng.nextInt(2);                              // 2–3 deep
    const h = heightMap[ccx + (ccz << 4)];
    if (h <= SEA_LEVEL + 2) return null;
    const reach = Math.ceil(Math.max(rx, rz)) + 1;
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const x = ccx + dx, z = ccz + dz;
      if (x < 1 || x > 14 || z < 1 || z > 14) return null;
      if (Math.abs(heightMap[x + (z << 4)] - h) > 1) return null; // not flat enough
    }
    return { ccx, ccz, rx, rz, depth, h, reach };
  }

  /**
   * Rare desert lava lake (Update #11 §3e): a 5–9 block crater 2–3 deep carved into flat desert, its floor and rim
   * made of stone so nothing can flow out, the lava surface flush with the ground. Skipped when water is anywhere
   * near. Returns 1 when a lake was made.
   */
  _desertLake(blocks, cx, cz, heightMap, biomeMap) {
    const L = this.desertLakeParams(cx, cz, heightMap, biomeMap);
    if (!L) return 0;
    const { ccx, ccz, rx, rz, depth, h, reach } = L;
    const inside = (x, z, grow) => ((x - ccx) / (rx + grow)) ** 2 + ((z - ccz) / (rz + grow)) ** 2 <= 1;
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const x = ccx + dx, z = ccz + dz;
      if (inside(x, z, 1) && this._waterNear(blocks, x, h, z, 4)) return 0;
    }
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const x = ccx + dx, z = ccz + dz, col = x + (z << 4);
      if (!inside(x, z, 1)) continue;
      const lake = inside(x, z, 0);
      for (let y = h - depth; y <= h + 2; y++) {
        const i = col + (y << 8);
        if (y > h) blocks[i] = B.AIR;                                     // clear plants and cacti above the crater
        else if (!lake || y === h - depth) blocks[i] = B.STONE;            // the rim and the floor
        else blocks[i] = B.LAVA;
      }
      if (!lake) for (let y = h + 1; y <= h + 1; y++) blocks[col + (y << 8)] = B.AIR;
    }
    return 1;
  }

  /** Any lava within `r` blocks (horizontally) of a column and above `minY`, by generating the chunks around it (spawn search, Update #11). */
  lavaNear(x, z, r = 16, minY = 0) {
    const cache = new Map();
    for (let cz = (z - r) >> 4; cz <= (z + r) >> 4; cz++) for (let cx = (x - r) >> 4; cx <= (x + r) >> 4; cx++) {
      const key = cx + ',' + cz;
      let g = cache.get(key);
      if (!g) { g = this.generateChunk(cx, cz); cache.set(key, g); }
      if (!g.lavaPools) continue;
      const b = g.blocks;
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const wx = cx * 16 + lx, wz = cz * 16 + lz;
        if (Math.abs(wx - x) > r || Math.abs(wz - z) > r) continue;
        const col = lx + (lz << 4);
        for (let y = Math.max(0, minY); y < WORLD_HEIGHT; y++) if (isLava(b[col + (y << 8)])) return true;
      }
    }
    return false;
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
