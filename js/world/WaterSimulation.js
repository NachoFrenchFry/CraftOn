// WaterSimulation.js — Minecraft-style scheduled liquid updates: flow down as falling liquid, spread
// sideways with weakening levels (water 7 blocks on flat ground, lava 3), prefer directions that lead to a
// drop within 4 blocks, recede when cut off, form infinite sources (water only), destroy plants and torches.
// Only scheduled blocks are ever touched, so still oceans cost nothing. The same class runs lava
// with the `lava` kind: a slower tick (Game), no new sources, and the owner's rule that lava touching water
// (any level, either way round) becomes cobblestone. Pure logic over a world interface; runs in Node for tests.
//
// a tick works through its scheduled cells until a time budget (WATER_TICK_BUDGET_MS) is used up,
// cells near the player first and otherwise oldest first; the rest waits for the next tick. Cells outside the
// simulation distance are paused (kept, not dropped) until the player comes closer. Cells are numeric keys (no
// strings), block reads go through a one-chunk cache, and the search for a drop is one breadth-first walk with a
// visited set instead of a 160-call recursion. Flow is always recorded as an edit, so settled water is saved and
// stays asleep when its chunk loads again; a chunk's cave springs are scheduled only while they can still flow
// (open air beside the source). Block changes never re-mesh synchronously (World.setBlock marks sections dirty).

import { BlockIds as B } from '../blocks/BlockIds.js';
import { SOLID, RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';
import { isWater, isSource, isFalling, levelOf, flowingId, isLava, isLavaSource, isLavaFalling, lavaLevelOf, lavaFlowingId, LAVA_MAX_LEVEL, isLiquid } from './WaterLevels.js';
import { MAX_WATER_UPDATES_PER_TICK, WATER_SLOPE_SEARCH, WATER_MAX_LEVEL, WATER_TICK_BUDGET_MS, WATER_NEAR_RADIUS, WORLD_HEIGHT } from '../config/Constants.js';
import { chunkKey, blockIndex } from './ChunkCoords.js';

/** The four horizontal directions; pairs are opposites (i ^ 1). */
const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];
const NO_SLOPE = 1000;
/** Numeric cell keys: x and z within ±2^20, y 0..255, exact in a double. */
const KEY_OFFSET = 1 << 20;
const KEY_SPAN = 1 << 21;
export function packCell(x, y, z) { return ((x + KEY_OFFSET) * KEY_SPAN + (z + KEY_OFFSET)) * 256 + y; }
export function cellX(key) { return Math.floor(key / (256 * KEY_SPAN)) - KEY_OFFSET; }
export function cellZ(key) { return (Math.floor(key / 256) % KEY_SPAN) - KEY_OFFSET; }
export function cellY(key) { return key % 256; }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** The slope search grid: WATER_SLOPE_SEARCH steps around the cell. */
const GRID_R = WATER_SLOPE_SEARCH, GRID_W = GRID_R * 2 + 1, GRID_CELLS = GRID_W * GRID_W;

/** The two liquids: block predicates, level helpers, how far they spread and whether sources form. */
export const LIQUID_KINDS = Object.freeze({
  water: Object.freeze({ name: 'water', is: isWater, isSource, isFalling, levelOf, flowingId, source: B.WATER, falling: B.FALLING_WATER, maxLevel: WATER_MAX_LEVEL, infiniteSources: true, springs: true }),
  lava: Object.freeze({ name: 'lava', is: isLava, isSource: isLavaSource, isFalling: isLavaFalling, levelOf: lavaLevelOf, flowingId: lavaFlowingId, source: B.LAVA, falling: B.FALLING_LAVA, maxLevel: LAVA_MAX_LEVEL, infiniteSources: false, springs: false }),
});

export class WaterSimulation {
  /**
   * @param {{getBlock(x,y,z):number, setBlock(x,y,z,id):void, isLoadedAt(x,z):boolean, getChunk?(cx,cz):object}} world
   * @param {(x:number,y:number,z:number,blockId:number)=>void} [onDestroy] called before the liquid replaces a plant / torch
   * @param {typeof LIQUID_KINDS.water} [kind] water (default) or lava
   */
  constructor(world, onDestroy = null, kind = LIQUID_KINDS.water) {
    this.world = world;
    this.onDestroy = onDestroy;
    this.kind = kind;
    /** (x, y, z) called when a lava block has just turned into cobblestone (sizzle + smoke). */
    this.onConvert = null;
    this.conversions = 0;
    /** Cell keys scheduled for the next tick, oldest first (insertion order). */
    this.pending = new Set();
    /** Scheduled cells outside the simulation distance: resumed when the player comes within range. */
    this.paused = new Set();
    /** scheduled cells farther than simRadius from the player wait (simulation distance). */
    this.simCenter = null;
    this.simRadius = Infinity;
    this._pausedAtX = Infinity; this._pausedAtZ = Infinity;
    /** chunk key → Set of cells waiting for that chunk to load. */
    this.deferred = new Map();
    /** Statistics (F3 / benchmark): updates and milliseconds of the last tick, the slowest tick, updates left waiting. */
    this.updatesLastTick = 0;
    this.lastTickMs = 0;
    this.maxTickMs = 0;
    this.leftover = 0;
    this._cc = null; this._ccx = 0; this._ccz = 0;
    this._bfsDist = new Uint8Array(GRID_CELLS);
    this._bfsDirs = new Uint8Array(GRID_CELLS);
    this._bfsQueue = new Int16Array(GRID_CELLS);
  }

  get pendingCount() { return this.pending.size; }
  get pausedCount() { return this.paused.size; }

  /** Forget every scheduled update (leaving / entering a world). */
  clear() {
    this.pending.clear();
    this.paused.clear();
    this.deferred.clear();
    this.updatesLastTick = 0; this.lastTickMs = 0; this.maxTickMs = 0; this.leftover = 0;
    this._cc = null;
  }

  schedule(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    this.pending.add(packCell(x, y, z));
  }

  /** Block id with a one-chunk cache (the simulation reads the same chunk hundreds of times per tick). */
  _get(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR;
    const w = this.world;
    if (!w.getChunk) return w.getBlock(x, y, z);
    const cx = x >> 4, cz = z >> 4;
    let c = this._cc;
    if (!c || cx !== this._ccx || cz !== this._ccz) { c = w.getChunk(cx, cz); this._cc = c; this._ccx = cx; this._ccz = cz; }
    return c ? c.blocks[blockIndex(x & 15, y, z & 15)] : B.AIR;
  }

  /**
   * A block changed: the block and its six neighbours may need an update — but only the cells that hold this liquid
   * are scheduled (a stale entry would still cost budget; with two simulations sharing every block change, the slow
   * lava tick would otherwise be starved by water's flow).
   */
  onBlockChanged(x, y, z) {
    this._cc = null; // chunks may have been unloaded since the last read
    const K = this.kind;
    if (K.is(this._get(x, y, z))) this.schedule(x, y, z);
    if (K.is(this._get(x + 1, y, z))) this.schedule(x + 1, y, z);
    if (K.is(this._get(x - 1, y, z))) this.schedule(x - 1, y, z);
    if (K.is(this._get(x, y + 1, z))) this.schedule(x, y + 1, z);
    if (K.is(this._get(x, y - 1, z))) this.schedule(x, y - 1, z);
    if (K.is(this._get(x, y, z + 1))) this.schedule(x, y, z + 1);
    if (K.is(this._get(x, y, z - 1))) this.schedule(x, y, z - 1);
  }

  /**
   * A chunk finished loading: resume updates that were waiting for it, and start its cave springs flowing — only those
   * that still can (a source with open air beside or below it); a spring whose flow is already there (saved edits) stays asleep.
   */
  onChunkLoaded(cx, cz) {
    this._cc = null;
    const key = chunkKey(cx, cz);
    const chunk = this.world.getChunk ? this.world.getChunk(cx, cz) : null;
    if (this.kind.springs && chunk && chunk.springs) {
      const s = chunk.springs;
      for (let i = 0; i + 2 < s.length; i += 3) {
        const x = cx * 16 + s[i], y = s[i + 1], z = cz * 16 + s[i + 2];
        if (this.kind.isSource(this._get(x, y, z)) && this._canSpread(x, y, z)) this.schedule(x, y, z);
      }
    }
    const waiting = this.deferred.get(key);
    if (!waiting) return;
    this.deferred.delete(key);
    for (const k of waiting) this.pending.add(k);
  }

  /** Something beside or below the cell is open for this liquid. */
  _canSpread(x, y, z) {
    if (y > 0 && this._canFlowInto(this._get(x, y - 1, z))) return true;
    for (let i = 0; i < 4; i++) if (this._canFlowInto(this._get(x + DX[i], y, z + DZ[i]))) return true;
    return false;
  }

  setSimulationCenter(x, z) { if (!this.simCenter) this.simCenter = { x, z }; else { this.simCenter.x = x; this.simCenter.z = z; } }

  /**
   * Process one scheduled tick (call every WATER_TICK_SECONDS): the cells scheduled so far, those within WATER_NEAR_RADIUS of
   * the player first, then the rest, each oldest first, until `budgetMs` of main-thread time is spent; what is left stays at
   * the front of the queue for the next tick. Cells scheduled by this tick's updates run next tick.
   */
  tick(budgetMs = WATER_TICK_BUDGET_MS) {
    this._cc = null;
    const t0 = now();
    const c = this.simCenter, r = this.simRadius;
    const limited = !!c && r !== Infinity;
    const r2 = r * r, near2 = WATER_NEAR_RADIUS * WATER_NEAR_RADIUS;
    // Cells paused outside the simulation distance come back once the player has moved (checked every 8 blocks of movement).
    if (this.paused.size && limited && (Math.abs(c.x - this._pausedAtX) > 8 || Math.abs(c.z - this._pausedAtZ) > 8)) {
      this._pausedAtX = c.x; this._pausedAtZ = c.z;
      for (const key of this.paused) {
        const dx = cellX(key) - c.x, dz = cellZ(key) - c.z;
        if (dx * dx + dz * dz <= r2) { this.paused.delete(key); this.pending.add(key); }
      }
    }
    const pend = this.pending;
    if (pend.size === 0) { this.updatesLastTick = 0; this.lastTickMs = 0; this.leftover = 0; return; }
    const limit = pend.size; // keys added during this tick land after these and wait for the next one
    let n = 0, i = 0, far = 0, stopped = false;
    for (const key of pend) {
      if (i++ >= limit) break;
      if (limited) {
        const dx = cellX(key) - c.x, dz = cellZ(key) - c.z, d2 = dx * dx + dz * dz;
        if (d2 > r2) { pend.delete(key); this.paused.add(key); continue; } // outside the simulation distance: paused, not dropped
        if (d2 > near2) { far++; continue; } // the second pass
      }
      if (n >= MAX_WATER_UPDATES_PER_TICK || ((n & 1) === 1 && now() - t0 >= budgetMs)) { stopped = true; break; }
      pend.delete(key);
      this._run(key);
      n++;
    }
    if (!stopped && far > 0) {
      i = 0;
      for (const key of pend) { // the far cells are now the first `far` entries, still oldest first
        if (i++ >= far) break;
        if (n >= MAX_WATER_UPDATES_PER_TICK || ((n & 1) === 1 && now() - t0 >= budgetMs)) break;
        pend.delete(key);
        this._run(key);
        n++;
      }
    }
    this.leftover = pend.size;
    this.updatesLastTick = n;
    this.lastTickMs = now() - t0;
    if (this.lastTickMs > this.maxTickMs) this.maxTickMs = this.lastTickMs;
  }

  _run(key) {
    const x = cellX(key), y = cellY(key), z = cellZ(key);
    if (!this.world.isLoadedAt(x, z)) { this._defer(x, z, key); return; }
    this.update(x, y, z);
  }

  _solid(id) { return SOLID[id] === 1; }

  /** A liquid may enter air, plants and torches (anything replaceable that is not a liquid). */
  _canFlowInto(id) {
    if (id === B.AIR) return true;
    if (this._solid(id) || isLiquid(id)) return false;
    const rt = RENDER_TYPE[id];
    return rt === RenderType.CROSS || rt === RenderType.TORCH;
  }

  /** Owner's rule: a lava block touching water on any of its six sides becomes cobblestone. Returns true when it did. */
  _quench(x, y, z) {
    if (!isLava(this._get(x, y, z))) return false;
    const touching = isWater(this._get(x + 1, y, z)) || isWater(this._get(x - 1, y, z)) || isWater(this._get(x, y, z + 1)) || isWater(this._get(x, y, z - 1))
      || isWater(this._get(x, y + 1, z)) || (y > 0 && isWater(this._get(x, y - 1, z)));
    if (!touching) return false;
    this.world.setBlock(x, y, z, B.COBBLESTONE, true);
    this.conversions++;
    if (this.onConvert) this.onConvert(x, y, z);
    return true;
  }

  /** Water arrived at (x, y, z): any lava next to it turns to cobblestone at once. */
  _quenchAround(x, y, z) {
    this._quench(x + 1, y, z); this._quench(x - 1, y, z); this._quench(x, y, z + 1); this._quench(x, y, z - 1);
    this._quench(x, y + 1, z); if (y > 0) this._quench(x, y - 1, z);
  }

  /** Park an update until the chunk containing (x, z) loads. */
  _defer(x, z, key) {
    const ck = chunkKey(x >> 4, z >> 4);
    let set = this.deferred.get(ck);
    if (!set) { set = new Set(); this.deferred.set(ck, set); }
    set.add(key);
  }

  /**
   * Put liquid at a target block. If the target's chunk isn't loaded, the *flowing* block's update is
   * deferred until it loads, so the flow resumes at chunk borders instead of being lost.
   */
  _set(x, y, z, id, fromKey) {
    if (!this.world.isLoadedAt(x, z)) { if (fromKey !== undefined) this._defer(x, z, fromKey); return false; }
    const cur = this._get(x, y, z);
    if (cur !== B.AIR && !isLiquid(cur) && this.onDestroy) this.onDestroy(x, y, z, cur);
    this.world.setBlock(x, y, z, id, true);
    if (this.kind.name === 'water') this._quenchAround(x, y, z); else if (this._quench(x, y, z)) return false;
    return true;
  }

  /** Recompute one liquid block of this kind, then let it flow. */
  update(x, y, z) {
    const K = this.kind;
    let id = this._get(x, y, z);
    if (!K.is(id)) return;
    // Lava next to water is cobblestone before anything else; water next to lava quenches it (the water stays).
    if (K.name === 'lava') { if (this._quench(x, y, z)) return; } else this._quenchAround(x, y, z);
    const key = packCell(x, y, z);
    const above = this._get(x, y + 1, z);
    const below = this._get(x, y - 1, z);

    // 1. Level from the surroundings (sources never change on their own).
    if (!K.isSource(id)) {
      let next;
      if (K.is(above)) next = K.falling;
      else {
        let min = K.maxLevel + 1, sources = 0;
        for (let i = 0; i < 4; i++) {
          const n = this._get(x + DX[i], y, z + DZ[i]);
          if (!K.is(n)) continue;
          const l = K.levelOf(n);
          if (l < min) min = l;
          if (K.isSource(n)) sources++;
        }
        if (K.infiniteSources && sources >= 2 && (this._solid(below) || K.isSource(below))) next = K.source; // infinite source (water only)
        else if (min + 1 > K.maxLevel) next = B.AIR;                                                          // nothing feeds it: dry up
        else next = K.flowingId(min + 1);
      }
      if (next !== id) {
        this.world.setBlock(x, y, z, next, true);
        if (next === B.AIR) return;
        id = next;
      }
    }

    // 2. Down first: fall into anything replaceable.
    if (y > 0 && this._canFlowInto(below)) {
      this._set(x, y - 1, z, K.falling, key);
      return;
    }
    // 3. Sideways only from a source or when resting on something solid (a falling column in mid-air does not).
    if (!(K.isSource(id) || this._solid(below))) return;
    const next = K.levelOf(id) + 1;
    if (next > K.maxLevel) return;
    const dirs = this._flowDirections(x, y, z);
    for (let i = 0; i < 4; i++) {
      if (!(dirs & (1 << i))) continue;
      const nx = x + DX[i], nz = z + DZ[i];
      const n = this._get(nx, y, nz);
      if (this._canFlowInto(n) || (K.is(n) && !K.isSource(n) && !K.isFalling(n) && K.levelOf(n) > next)) {
        this._set(nx, y, nz, K.flowingId(next), key);
      }
    }
  }

  /** Neighbour is passable for spreading: not solid, not the other liquid and not a source of this one. */
  _passable(id) { return !this._solid(id) && !(isLiquid(id) && !this.kind.is(id)) && !(this.kind.is(id) && this.kind.isSource(id)); }

  /**
   * Directions (bitmask over DX / DZ) with the shortest path to a drop within WATER_SLOPE_SEARCH blocks; all passable
   * ones when there is none. A neighbour with nothing solid under it is a drop at distance 0 and wins outright.
   */
  _flowDirections(x, y, z) {
    let mask = 0, drops = 0;
    for (let i = 0; i < 4; i++) {
      const n = this._get(x + DX[i], y, z + DZ[i]);
      if (!this._passable(n)) continue;
      if (!this._solid(this._get(x + DX[i], y - 1, z + DZ[i]))) drops |= 1 << i; else mask |= 1 << i;
    }
    if (drops) return drops;
    if (!mask) return 0;
    return this._slopeSearch(x, y, z, mask);
  }

  /**
   * One breadth-first walk over the passable cells at this height (the old 4-way recursion visited ~160
   * cells with ~960 block reads per call and no visited set). Every cell remembers which starting directions reach it at its
   * shortest distance; the directions of the cells next to the nearest drop are the answer, ties included — the same result
   * as searching each direction on its own.
   */
  _slopeSearch(x, y, z, firstMask) {
    const dist = this._bfsDist, dirs = this._bfsDirs, q = this._bfsQueue;
    dist.fill(255);
    const C = GRID_R, W = GRID_W;
    dist[C * W + C] = 0;
    let head = 0, tail = 0;
    for (let i = 0; i < 4; i++) {
      if (!(firstMask & (1 << i))) continue;
      const gi = (C + DZ[i]) * W + (C + DX[i]);
      dist[gi] = 1; dirs[gi] = 1 << i; q[tail++] = gi;
    }
    let best = NO_SLOPE, mask = 0;
    while (head < tail) {
      const gi = q[head++];
      const d = dist[gi];
      if (d > best) break; // breadth-first: nothing farther can tie
      const gx = (gi % W) - C, gz = Math.floor(gi / W) - C;
      const wx = x + gx, wz = z + gz;
      for (let i = 0; i < 4; i++) {
        const nx = wx + DX[i], nz = wz + DZ[i];
        if (!this._passable(this._get(nx, y, nz))) continue;
        if (!this._solid(this._get(nx, y - 1, nz))) { if (d < best) { best = d; mask = 0; } mask |= dirs[gi]; continue; } // a drop beside this cell
        if (d >= WATER_SLOPE_SEARCH) continue;
        const ngx = gx + DX[i] + C, ngz = gz + DZ[i] + C;
        if (ngx < 0 || ngx >= W || ngz < 0 || ngz >= W) continue;
        const ni = ngz * W + ngx;
        if (dist[ni] === 255) { dist[ni] = d + 1; dirs[ni] = dirs[gi]; q[tail++] = ni; }
        else if (dist[ni] === d + 1) dirs[ni] |= dirs[gi]; // a tie: both starting directions reach it as fast
      }
    }
    return best === NO_SLOPE ? firstMask : mask;
  }

  /**
   * Flow direction of the water at a block (unit vector or zero), for pushing entities.
   * out: {x, y, z}
   */
  flowVector(x, y, z, out) {
    const K = this.kind;
    const id = this.world.getBlock(x, y, z);
    out.x = 0; out.y = 0; out.z = 0;
    if (!K.is(id)) return out;
    const decay = K.levelOf(id);
    for (let i = 0; i < 4; i++) {
      const dx = DX[i], dz = DZ[i];
      const n = this.world.getBlock(x + dx, y, z + dz);
      let k = 0;
      if (K.is(n)) k = K.levelOf(n) - decay;
      else if (!this._solid(n)) {
        const under = this.world.getBlock(x + dx, y - 1, z + dz);
        if (K.is(under)) k = K.levelOf(under) - (decay - 8);
      }
      out.x += dx * k; out.z += dz * k;
    }
    if (K.isFalling(id)) out.y -= 6;
    const len = Math.hypot(out.x, out.y, out.z);
    if (len > 0) { out.x /= len; out.y /= len; out.z /= len; }
    return out;
  }
}
