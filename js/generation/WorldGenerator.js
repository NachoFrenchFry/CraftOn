// WorldGenerator.js — orchestrates all generation passes for one chunk, in order:
// terrain → surface/bedrock → caves → water → ores → decorations. Deterministic per (seed, cx, cz).
// Worker-safe; also usable on the main thread (e.g. for spawn finding).

import { SEA_LEVEL, BLOCKS_PER_CHUNK, WORLD_HEIGHT, MIN_CAVE_Y, CHEESE_TOP_Y, CAVE_SPRING_MIN, CAVE_SPRING_MAX, CAVE_SPRING_CAVERN_BLOCKS, LAVA_POOL_CAVERN_BLOCKS, LAVA_POOL_MAX_Y, LAVA_POOL_MAX_CELLS, LAVA_POOL_CHANCE, LAVA_SEA_LEVEL, DESERT_LAKE_CHANCE, MEGA_CAVE_DIAMOND_FACTOR } from '../config/Constants.js';
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
    /** Desert lake parameters per chunk cell. */
    this._lakeCache = new Map();
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
        // Steep high mountain faces get overhangs and notches from the coarse 3D noise.
        const h = heights[hi];
        const dh = Math.max(Math.abs(h - heights[hi - 1]), Math.abs(h - heights[hi + 1]), Math.abs(h - heights[hi - HM_SIZE]), Math.abs(h - heights[hi + HM_SIZE]));
        this.cliffMask[col] = biomeIds[hi] === BiomeIds.MOUNTAINS && h >= 100 && dh >= 4 ? 1 : 0;
      }
    }
    this.caves.carve(blocks, cx, cz, this.carveMaxY);
    const carved = this.noiseCaves.carve(blocks, cx, cz, this.carveMaxY, maxHeight, this.heightMap16, this.cliffMask);
    const cheeseBlocks = carved && carved.cheeseBlocks ? carved.cheeseBlocks : 0;
    const mega = carved && carved.mega ? carved.mega : 0; // mega-cave region share of this chunk
    // Ravines: long deep cracks opening at the surface (land only; see RavineCarver.js).
    this.ravines.carve(blocks, cx, cz, this.heightMap16, mega > 0 ? this.noiseCaves.megaMask : null);
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

    // 5. Ores and dirt/gravel pockets, then exposed ore clusters on cave walls (mega caves: many more diamonds).
    this.ores.generate(blocks, cx, cz, hasMountains);
    this.ores.exposeOres(blocks, cx, cz, heightMap, 1 + (MEGA_CAVE_DIAMOND_FACTOR - 1) * mega);
    // Lava sea: every cave cell at or below LAVA_SEA_LEVEL is lava — the floors of deep caverns become
    // lakes as wide as the cavern, continuous across chunks (the neighbour fills the same level), so nothing flows.
    const seaCells = this._lavaSea(blocks, heightMap);
    // Cave springs: single water sources in the walls of big caverns (scheduled to flow when the chunk loads).
    const springs = this._caveSprings(blocks, cx, cz, heightMap, cheeseBlocks);
    // Lava pools: closed floor basins of ordinary caves below LAVA_POOL_MAX_Y.
    let lavaPools = this._lavaPools(blocks, cx, cz, heightMap, cheeseBlocks) + (seaCells > 0 ? 1 : 0);

    // 6. Trees, plants and other decorations.
    this.decorator.decorate(blocks, cx, cz, biomeMap, this.heightMap16);
    // Desert lava lakes (after the plants, so the crater is clear of cacti and bushes); they may span several chunks.
    lavaPools += this._desertLakes(blocks, cx, cz);

    // 7. Safety: no air or water may touch bedrock, so bedrock is never visible from caves.
    this._sealBedrock(blocks);

    return { blocks, heightMap, biomeMap, springs, lavaPools, mega };
  }

  /**
   * The lava sea: air at y ≤ LAVA_SEA_LEVEL (inside the cave band) becomes lava; where water lies within 3 blocks the air
   * becomes stone instead, so lava never touches water and the sea surface stays closed. Returns the lava cells made.
   */
  _lavaSea(blocks, heightMap) {
    let cells = 0;
    for (let y = MIN_CAVE_Y; y <= LAVA_SEA_LEVEL; y++) {
      const yb = y << 8;
      for (let col = 0; col < 256; col++) {
        const i = col + yb;
        if (blocks[i] !== B.AIR || y >= heightMap[col] - 4) continue;
        if (this._waterNear(blocks, col & 15, y, col >> 4, 3)) { blocks[i] = B.STONE; continue; }
        blocks[i] = B.LAVA;
        cells++;
      }
    }
    return cells;
  }

  /** Any lava in the chunk within `r` blocks of (lx, y, lz) (chunk-local). */
  _lavaNear(blocks, lx, y, lz, r) {
    for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const x = lx + dx, z = lz + dz, yy = y + dy;
      if (x < 0 || x > 15 || z < 0 || z > 15 || yy < 0 || yy > 255) continue;
      if (isLava(blocks[x + (z << 4) + (yy << 8)])) return true;
    }
    return false;
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
   * Lava pools: in a chunk with a big cheese cavern, every cave-floor cell below LAVA_POOL_MAX_Y is a
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
    const want = 1 + rng.nextInt(3);
    let pools = 0;
    const tried = new Set();
    const stack = [];
    for (let y = LAVA_SEA_LEVEL + 1; y <= LAVA_POOL_MAX_Y && pools < want; y++) {
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

  /**
   * Desert lava lakes (resized): one candidate per chunk cell with chance
   * DESERT_LAKE_CHANCE, 3–10 blocks across and 1–3 deep, placed anywhere in that chunk — a lake may still straddle a
   * border, so every chunk it touches carves its own part from the same deterministic parameters. The checks use only
   * the global terrain functions (biome and height from the shaper), never a chunk's blocks: the ground around the lake
   * must be desert and within 4 blocks of the centre height, well above the sea. Cached per cell.
   * @returns {{x:number, z:number, rx:number, rz:number, depth:number, h:number}|null}
   */
  desertLakeParams(cx, cz) {
    const key = cx + ',' + cz;
    if (this._lakeCache.has(key)) return this._lakeCache.get(key);
    let lake = null;
    const rng = chunkRandom(this.seed, cx, cz, LAKE_SALT);
    if (rng.chance(DESERT_LAKE_CHANCE)) {
      const x = cx * 16 + rng.nextInt(16), z = cz * 16 + rng.nextInt(16);
      const rx = 1.5 + rng.next() * 3.5, rz = 1.5 + rng.next() * 3.5;    // 3–10 blocks across
      const depth = 1 + rng.nextInt(3);                                   // 1–3 deep
      const s = createColumnSample();
      const h = this.shaper.heightAt(x, z);
      let ok = h > SEA_LEVEL + 3;
      for (let k = 0; k < 9 && ok; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = k === 8 ? x : x + Math.cos(a) * (rx + 3), pz = k === 8 ? z : z + Math.sin(a) * (rz + 3);
        const smp = this.shaper.sample(px, pz, s);
        if (this.biomes.classify(smp) !== BiomeIds.DESERT || Math.abs(smp.height - h) > 4 || smp.height <= SEA_LEVEL + 1) ok = false;
      }
      if (ok) lake = { x, z, rx, rz, depth, h };
    }
    if (this._lakeCache.size > 512) this._lakeCache.clear();
    this._lakeCache.set(key, lake);
    return lake;
  }

  /** Deterministic per-column noise for the rim (0..1), from the seed and the world column. */
  _rimNoise(x, z, salt = 0) {
    let h = (this.seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt + 1, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /**
   * Carve every desert lake that reaches into this chunk: lava flush with the ground over a stone / cobblestone floor,
   * inside a rocky rim 2–3 blocks wide (a noisy mix of about 45 % cobblestone, 40 % stone and 15 % mossy cobblestone)
   * that goes one block deeper than the lava and blends into the sand at its outer edge. Sealed: every lava cell's
   * neighbours at its level are rim or lava, the floor is solid.
   */
  _desertLakes(blocks, cx, cz) {
    let made = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const L = this.desertLakeParams(cx + dx, cz + dz);
      if (!L) continue;
      const wx0 = cx * 16, wz0 = cz * 16;
      if (L.x + L.rx + 4 < wx0 || L.x - L.rx - 4 > wx0 + 15 || L.z + L.rz + 4 < wz0 || L.z - L.rz - 4 > wz0 + 15) continue;
      const inside = (x, z, grow) => ((x + 0.5 - L.x) / (L.rx + grow)) ** 2 + ((z + 0.5 - L.z) / (L.rz + grow)) ** 2 <= 1;
      let touched = false;
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const x = wx0 + lx, z = wz0 + lz;
        const rimWidth = 2 + (this._rimNoise(x, z, 1) < 0.5 ? 1 : 0);        // 2 or 3 blocks of rim, per column
        if (!inside(x, z, rimWidth)) continue;
        touched = true;
        const col = lx + (lz << 4);
        const lake = inside(x, z, 0);
        const outerEdge = !inside(x, z, rimWidth - 1);                        // the rim's outermost block blends into the sand
        const pick = this._rimNoise(x, z, 2);
        const rock = pick < 0.45 ? B.COBBLESTONE : pick < 0.85 ? B.STONE : B.MOSSY_COBBLESTONE;
        for (let y = L.h - L.depth - 1; y <= L.h + 5; y++) {
          if (y < 1 || y > 254) continue;
          const i = col + (y << 8);
          if (y > L.h) { if (blocks[i] !== B.BEDROCK) blocks[i] = B.AIR; continue; }               // clear plants, cacti and dunes above the crater
          if (lake) { blocks[i] = y <= L.h - L.depth ? (pick < 0.6 ? B.STONE : B.COBBLESTONE) : B.LAVA; continue; } // the floor and the lava
          // The rim: rock all the way down; at the outer edge the top layer is sand half of the time, so it fades out.
          blocks[i] = outerEdge && y === L.h && this._rimNoise(x, z, 3) < 0.5 ? B.SAND : rock;
        }
      }
      if (touched) made++;
    }
    return made;
  }

  /** Any lava within `r` blocks (horizontally) of a column and above `minY`, by generating the chunks around it (spawn search). */
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
      if (nearWater || this._lavaNear(blocks, lx, y, lz, 3)) continue;
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
