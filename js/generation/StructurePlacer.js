// StructurePlacer.js — deterministic, cross-chunk structure placement (README "Structures"). The world is divided into
// regions of spacing × spacing chunks per structure type; each region gets at most one start (from the seed, the
// structure name and the region coordinates, at least `separation` chunks from the region edge), the `chance` decides
// whether it spawns, then the biome and the placement mode's rules (surface: gentle ground, never in water; ocean_surface:
// floating at sea level on deep water; underground: a depth range inside stone; tree: forest ground). A start is a list
// of pieces (one, or a group's several pieces with offsets), each with its own ground height. When a chunk generates,
// every start whose bounding box overlaps it writes only the blocks inside that chunk — so every chunk still generates
// independently and deterministically (guests generate terrain locally). Region starts are cached. Worker-safe.

import { SEA_LEVEL, WORLD_HEIGHT } from '../config/Constants.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { SOLID } from '../blocks/BlockRegistry.js';
import { BiomeIds } from './Biomes.js';
import { VOID, rotateOffset, unrotateOffset } from './StructureRegistry.js';
import { Random, hashSeed } from '../utils/Random.js';
import { hash3 } from '../utils/MathUtils.js';
import { findSpawnColumn } from './SpawnFinder.js';

const BIOME_BY_NAME = { ocean: BiomeIds.OCEAN, beach: BiomeIds.BEACH, plains: BiomeIds.PLAINS, forest: BiomeIds.FOREST, desert: BiomeIds.DESERT, snowy: BiomeIds.SNOWY, mountains: BiomeIds.MOUNTAINS };
/** No structure within this many blocks of the spawn column. */
export const SPAWN_CLEARANCE = 16;
const LOOT_SALT = 0x10a7;
/** Candidate positions tried per region before giving up (hilly ground and biome edges reject many spots). */
const REGION_ATTEMPTS = 8;
const NEAR_CACHE_MAX = 4096;
/** Surface blocks a group's path may pave over. */
const PATH_GROUND = new Set([B.GRASS_BLOCK, B.DIRT, B.SAND, B.SNOWY_GRASS, B.GRAVEL, B.STONE, B.SANDSTONE, B.SNOW]);

export class StructurePlacer {
  /**
   * @param {import('./WorldGenerator.js').WorldGenerator} gen
   * @param {import('./StructureRegistry.js').StructureRegistry} registry
   */
  constructor(gen, registry) {
    this.gen = gen;
    this.seed = gen.seed >>> 0;
    this.registry = registry;
    /** "name|rx,rz" → start or null */
    this.regionCache = new Map();
    /** "cx,cz" → starts overlapping that chunk */
    this.nearCache = new Map();
    this._spawn = undefined;
    this._mask = new Uint8Array(256);
    /** Per-structure chunk reach: ceil((reach + 16) / 16) chunks around a start can hold its blocks. */
    this._chunkReach = new Map();
    for (const s of registry.list) this._chunkReach.set(s.name, Math.ceil((s.reach + 16) / 16) + 1);
  }

  /**
   * The world's spawn column (the same scored search WorldSession runs on a plain generator), so nothing is placed on top
   * of it. The search's lava check generates a few chunks: structures are switched off meanwhile (no recursion, and the
   * same answer as the main thread's structure-less search).
   */
  spawn() {
    if (this._spawn === undefined) {
      const g = this.gen, saved = g.structures, savedDec = g.decorator ? g.decorator.structures : null;
      g.structures = null; if (g.decorator) g.decorator.structures = null;
      this._spawn = { x: 0, z: 0 };
      try { const best = findSpawnColumn(g); if (best) this._spawn = { x: best.x, z: best.z }; }
      finally { g.structures = saved; if (g.decorator) g.decorator.structures = savedDec; }
    }
    return this._spawn;
  }

  /** The candidate start of structure `def` in region (rx, rz), or null. Cached. */
  regionStart(def, rx, rz) {
    const key = def.name + '|' + rx + ',' + rz;
    const cached = this.regionCache.get(key);
    if (cached !== undefined) return cached;
    let start = null;
    const p = def.placement;
    const rng = new Random(hash3(this.seed ^ def.salt, rx, rz));
    if (rng.chance(p.chance)) {
      const span = Math.max(1, p.spacing - 2 * p.separation);
      for (let attempt = 0; attempt < REGION_ATTEMPTS && !start; attempt++) {
        const cx = rx * p.spacing + p.separation + rng.nextInt(span), cz = rz * p.spacing + p.separation + rng.nextInt(span);
        const x = cx * 16 + rng.nextInt(16), z = cz * 16 + rng.nextInt(16);
        const rot = p.rotate ? rng.nextInt(4) : 0;
        start = this._tryStart(def, x, z, rot, rng);
      }
    }
    this.regionCache.set(key, start);
    return start;
  }

  _biomeOk(def, x, z) {
    const biome = this.gen.biomeAt(x, z);
    const want = def.placement.biomes;
    if (want.length) return want.some((n) => BIOME_BY_NAME[n] === biome);
    return def.placement.mode === 'underground' || biome !== BiomeIds.OCEAN; // no biome list: anywhere on land
  }

  _tryStart(def, x, z, rot, rng) {
    const p = def.placement, mode = p.mode;
    if (!this._biomeOk(def, x, z)) return null;
    const pieces = [];
    if (def.group) {
      for (const pc of def.pieces) {
        const take = pc.chance >= 1 || rng.chance(pc.chance);
        const prot = ((pc.rotation === 'random' ? rng.nextInt(4) : pc.rotation) + rot) & 3; // always drawn: the roll order never depends on earlier pieces
        if (!take) continue;
        const [ox, oz] = rotateOffset(pc.offset[0], pc.offset[2], rot);
        const piece = this._pieceAt(this.registry.byName.get(pc.structure), x + ox, z + oz, prot, mode, rng, p);
        if (piece) pieces.push(piece);
      }
      if (pieces.length < Math.min(2, def.pieces.length)) return null;
    } else {
      const piece = this._pieceAt(def, x, z, rot, mode, rng, p);
      if (!piece) return null;
      pieces.push(piece);
    }
    const bbox = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const pc of pieces) { bbox.minX = Math.min(bbox.minX, pc.fp.minX); bbox.maxX = Math.max(bbox.maxX, pc.fp.maxX); bbox.minZ = Math.min(bbox.minZ, pc.fp.minZ); bbox.maxZ = Math.max(bbox.maxZ, pc.fp.maxZ); }
    const sp = this.spawn();
    if (sp.x >= bbox.minX - SPAWN_CLEARANCE && sp.x <= bbox.maxX + SPAWN_CLEARANCE && sp.z >= bbox.minZ - SPAWN_CLEARANCE && sp.z <= bbox.maxZ + SPAWN_CLEARANCE) return null;
    const start = { def, name: def.name, x, y: pieces[0].y, z, rot, mode, pieces, bbox, paths: null };
    if (def.group && def.paths && pieces.length > 1) {
      // L-shaped gravel paths between consecutive pieces (along x first, then z), widened to the group's bounding box.
      const cells = new Set();
      for (let i = 0; i + 1 < pieces.length; i++) {
        const a = pieces[i], b = pieces[i + 1];
        for (let xx = Math.min(a.x, b.x); xx <= Math.max(a.x, b.x); xx++) cells.add(xx + ',' + a.z);
        for (let zz = Math.min(a.z, b.z); zz <= Math.max(a.z, b.z); zz++) cells.add(b.x + ',' + zz);
      }
      start.paths = [...cells].map((k) => k.split(',').map(Number));
      for (const [px, pz] of start.paths) { bbox.minX = Math.min(bbox.minX, px); bbox.maxX = Math.max(bbox.maxX, px); bbox.minZ = Math.min(bbox.minZ, pz); bbox.maxZ = Math.max(bbox.maxZ, pz); }
    }
    return start;
  }

  /** The rotated footprint rectangle (world xz) of a structure whose anchor sits at (x, z). */
  static footprint(struct, x, z, rot) {
    const [sx, , sz] = struct.size, [ax, , az] = struct.anchor;
    const fp = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const [lx, lz] of [[0, 0], [sx - 1, 0], [0, sz - 1], [sx - 1, sz - 1]]) {
      const [dx, dz] = rotateOffset(lx - ax, lz - az, rot);
      fp.minX = Math.min(fp.minX, x + dx); fp.maxX = Math.max(fp.maxX, x + dx); fp.minZ = Math.min(fp.minZ, z + dz); fp.maxZ = Math.max(fp.maxZ, z + dz);
    }
    return fp;
  }

  /** Median / min / max terrain height under a footprint (sampled every `stride` blocks), or null when it touches water. */
  _ground(fp, maxSlope) {
    const w = fp.maxX - fp.minX + 1, d = fp.maxZ - fp.minZ + 1;
    const stride = Math.max(1, Math.round(Math.max(w, d) / 6));
    const hs = [];
    for (let zz = fp.minZ; ; zz += stride) {
      if (zz > fp.maxZ) zz = fp.maxZ;
      for (let xx = fp.minX; ; xx += stride) {
        if (xx > fp.maxX) xx = fp.maxX;
        const h = this.gen.surfaceHeight(xx, zz);
        if (h <= SEA_LEVEL) return null;
        hs.push(h);
        if (xx === fp.maxX) break;
      }
      if (zz === fp.maxZ) break;
    }
    hs.sort((a, b) => a - b);
    const min = hs[0], max = hs[hs.length - 1];
    if (max - min > maxSlope) return null;
    return { median: hs[hs.length >> 1], min, max };
  }

  _pieceAt(struct, x, z, rot, mode, rng, placement) {
    if (!struct) return null;
    const fp = StructurePlacer.footprint(struct, x, z, rot);
    let y;
    if (mode === 'ocean_surface') {
      // Floating at sea level on water at least about 5 deep, not in a frozen ocean.
      let max = -Infinity; const hs = [];
      const stride = Math.max(1, Math.round(Math.max(fp.maxX - fp.minX, fp.maxZ - fp.minZ) / 5));
      for (let zz = fp.minZ; zz <= fp.maxZ + stride - 1; zz += stride) for (let xx = fp.minX; xx <= fp.maxX + stride - 1; xx += stride) { const h = this.gen.surfaceHeight(Math.min(xx, fp.maxX), Math.min(zz, fp.maxZ)); hs.push(h); if (h > max) max = h; }
      hs.sort((a, b) => a - b);
      if (max > SEA_LEVEL - 4 || hs[hs.length >> 1] > SEA_LEVEL - 5) return null;
      if (this.gen._isCold && this.gen._isCold(x, z)) return null;
      y = SEA_LEVEL + 1;
    } else if (mode === 'underground') {
      const [lo, hi] = placement.yRange;
      y = rng.nextIntRange(Math.min(lo, hi), Math.max(lo, hi));
      if (this.gen.biomeAt(x, z) === BiomeIds.OCEAN) return null;
      if (this.gen.surfaceHeight(x, z) < y - struct.anchor[1] + struct.size[1] + 8) return null; // well inside the ground
    } else {
      const g = this._ground(fp, mode === 'tree' ? Math.min(3, placement.maxSlope) : placement.maxSlope);
      if (!g) return null;
      y = g.median + 1;
    }
    return { struct, x, y, z, rot, fp };
  }

  /** Every start whose bounding box overlaps chunk (cx, cz). Cached per chunk. */
  startsNear(cx, cz) {
    const key = cx + ',' + cz;
    const cached = this.nearCache.get(key);
    if (cached) return cached;
    const out = [];
    const wx0 = cx * 16, wz0 = cz * 16, wx1 = wx0 + 15, wz1 = wz0 + 15;
    for (const def of this.registry.list) {
      const R = this._chunkReach.get(def.name), sp = def.placement.spacing;
      const rx0 = Math.floor((cx - R) / sp), rx1 = Math.floor((cx + R) / sp), rz0 = Math.floor((cz - R) / sp), rz1 = Math.floor((cz + R) / sp);
      for (let rz = rz0; rz <= rz1; rz++) for (let rx = rx0; rx <= rx1; rx++) {
        const st = this.regionStart(def, rx, rz);
        if (st && st.bbox.minX <= wx1 && st.bbox.maxX >= wx0 && st.bbox.minZ <= wz1 && st.bbox.maxZ >= wz0) out.push(st);
      }
    }
    if (this.nearCache.size >= NEAR_CACHE_MAX) this.nearCache.clear();
    this.nearCache.set(key, out);
    return out;
  }

  /** True when a structure piece or path covers the column (wx, wz): trees and plants never grow there. */
  columnBlocked(wx, wz) {
    const starts = this.startsNear(wx >> 4, wz >> 4);
    for (const st of starts) {
      if (wx < st.bbox.minX || wx > st.bbox.maxX || wz < st.bbox.minZ || wz > st.bbox.maxZ) continue;
      for (const pc of st.pieces) if (wx >= pc.fp.minX && wx <= pc.fp.maxX && wz >= pc.fp.minZ && wz <= pc.fp.maxZ) return true;
      if (st.paths) for (const [px, pz] of st.paths) if (px === wx && pz === wz) return true;
    }
    return false;
  }

  /**
   * Write every structure block that falls inside chunk (cx, cz): foundations down to the ground, the blocks (air carves,
   * structure_void leaves the terrain), the clearing above, group paths; roll the chests' loot.
   * @returns {{containers: {index: number, slots: Array}[]|null, mask: Uint8Array|null}} chest contents by chunk-local
   *   block index, and the 16×16 mask of columns a structure covers (trees and plants skip them)
   */
  place(blocks, cx, cz, heightMap16) {
    const starts = this.startsNear(cx, cz);
    if (!starts.length) return { containers: null, mask: null };
    const mask = this._mask; mask.fill(0);
    const containers = [];
    const wx0 = cx * 16, wz0 = cz * 16;
    for (const st of starts) {
      for (const pc of st.pieces) this._writePiece(blocks, pc, st.mode, wx0, wz0, heightMap16, mask, containers);
      if (st.paths) {
        const block = st.def.paths.block;
        for (const [px, pz] of st.paths) {
          const lx = px - wx0, lz = pz - wz0;
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
          const col = lx + (lz << 4);
          if (mask[col]) continue; // inside a piece
          const h = heightMap16[col];
          if (h <= SEA_LEVEL || h + 1 >= WORLD_HEIGHT) continue;
          const i = col + (h << 8);
          if (PATH_GROUND.has(blocks[i])) { blocks[i] = block; blocks[i + 256] = B.AIR; mask[col] = 1; }
        }
      }
    }
    return { containers: containers.length ? containers : null, mask };
  }

  _writePiece(blocks, pc, mode, wx0, wz0, heightMap16, mask, containers) {
    const s = pc.struct, [sx, sy, sz] = s.size, [ax, ay, az] = s.anchor, fp = pc.fp;
    const x0 = Math.max(fp.minX, wx0), x1 = Math.min(fp.maxX, wx0 + 15), z0 = Math.max(fp.minZ, wz0), z1 = Math.min(fp.maxZ, wz0 + 15);
    if (x0 > x1 || z0 > z1) return;
    const ids = s.ids(pc.rot), baseY = pc.y - ay, layer = sx * sz;
    const surface = mode === 'surface' || mode === 'tree';
    const foundation = surface ? s.placement.foundation : 0, clear = surface && s.placement.clearAbove;
    for (let wz = z0; wz <= z1; wz++) {
      for (let wx = x0; wx <= x1; wx++) {
        const [dx, dz] = unrotateOffset(wx - pc.x, wz - pc.z, pc.rot);
        const lx = dx + ax, lz = dz + az;
        if (lx < 0 || lx >= sx || lz < 0 || lz >= sz) continue;
        const col = (wx - wx0) + ((wz - wz0) << 4);
        mask[col] = 1;
        const h = heightMap16[col], colBase = lx + lz * sx;
        if (foundation) {
          // Foundation: fill downward under the solid parts of the bottom layer until the ground.
          const bottom = ids[colBase];
          if (bottom !== VOID && bottom !== B.AIR && SOLID[bottom]) for (let y = Math.max(1, h + 1); y < baseY && y < WORLD_HEIGHT; y++) blocks[col + (y << 8)] = foundation;
        }
        for (let ly = 0; ly < sy; ly++) {
          const wy = baseY + ly;
          if (wy < 1 || wy >= WORLD_HEIGHT) continue;
          const id = ids[colBase + ly * layer], i = col + (wy << 8);
          if (id === VOID) { if (clear && wy >= pc.y && blocks[i] !== B.AIR) blocks[i] = B.AIR; } // the clearing: terrain above the ground plane goes, never the ground itself
          else blocks[i] = id;
        }
        if (clear) for (let wy = baseY + sy; wy < baseY + sy + 2 && wy < WORLD_HEIGHT; wy++) blocks[col + (wy << 8)] = B.AIR;
      }
    }
    // Chests: deterministic loot from the seed and the chest position (a `chance` below 1 may leave the cell empty).
    for (const c of s.containers) {
      const [dx, dz] = rotateOffset(c.pos[0] - ax, c.pos[2] - az, pc.rot);
      const wx = pc.x + dx, wz = pc.z + dz, wy = baseY + c.pos[1];
      const lx = wx - wx0, lz = wz - wz0;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || wy < 1 || wy >= WORLD_HEIGHT) continue;
      const index = lx + (lz << 4) + (wy << 8);
      const rng = new Random(hash3(hash3(this.seed ^ LOOT_SALT, wx, wz), wy, hashSeed(c.loot)));
      if (c.chance < 1 && !rng.chance(c.chance)) { blocks[index] = B.AIR; continue; }
      containers.push({ index, slots: this.registry.loot.roll(c.loot, rng) });
    }
  }

  /**
   * The nearest start of one structure type to (x, z) within `maxDist` blocks (for /locate): rings of regions around the
   * player's region, stopping once a ring cannot hold anything closer than the best start found. Only region starts are
   * evaluated (the pure height / biome functions), never chunks.
   */
  nearest(name, x, z, maxDist) {
    const def = this.registry.byName.get(name);
    if (!def) return null;
    const sp = def.placement.spacing, S = sp * 16;
    const rx0 = Math.floor(Math.floor(x / 16) / sp), rz0 = Math.floor(Math.floor(z / 16) / sp);
    let best = null, bestD = Infinity;
    const K = Math.ceil(maxDist / S) + 1;
    const consider = (rx, rz) => {
      const st = this.regionStart(def, rx, rz);
      if (!st) return;
      const d = Math.hypot(st.x - x, st.z - z);
      if (d <= maxDist && d < bestD) { best = st; bestD = d; }
    };
    for (let k = 0; k <= K; k++) {
      if ((k - 1) * S > Math.min(bestD, maxDist)) break; // a start in ring k lies at least (k − 1) regions away
      if (k === 0) { consider(rx0, rz0); continue; }
      for (let i = -k; i <= k; i++) { consider(rx0 + i, rz0 - k); consider(rx0 + i, rz0 + k); }
      for (let j = -k + 1; j <= k - 1; j++) { consider(rx0 - k, rz0 + j); consider(rx0 + k, rz0 + j); }
    }
    return best;
  }

  /** Every start whose anchor lies within `radius` blocks of (x, z) — for the Node check and /locate (Part 3). */
  startsWithin(x, z, radius) {
    const out = [];
    for (const def of this.registry.list) {
      const sp = def.placement.spacing;
      const rx0 = Math.floor(((x - radius) >> 4) / sp), rx1 = Math.floor(((x + radius) >> 4) / sp);
      const rz0 = Math.floor(((z - radius) >> 4) / sp), rz1 = Math.floor(((z + radius) >> 4) / sp);
      for (let rz = rz0; rz <= rz1; rz++) for (let rx = rx0; rx <= rx1; rx++) {
        const st = this.regionStart(def, rx, rz);
        if (st && Math.abs(st.x - x) <= radius && Math.abs(st.z - z) <= radius) out.push(st);
      }
    }
    return out;
  }
}
