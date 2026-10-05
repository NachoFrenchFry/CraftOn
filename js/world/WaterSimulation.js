// WaterSimulation.js — Minecraft-style scheduled water updates: flow down as falling water, spread
// sideways with weakening levels (7 blocks on flat ground), prefer directions that lead to a drop within
// 4 blocks, recede when cut off, form infinite sources, destroy plants. Only scheduled blocks are ever
// touched, so still oceans cost nothing. Pure logic over a world interface; runs in Node for tests.

import { BlockIds as B } from '../blocks/BlockIds.js';
import { SOLID, RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';
import { isWater, isSource, isFalling, levelOf, flowingId } from './WaterLevels.js';
import { MAX_WATER_UPDATES_PER_TICK, WATER_SLOPE_SEARCH, WATER_MAX_LEVEL } from '../config/Constants.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NO_SLOPE = 1000;

export class WaterSimulation {
  /**
   * @param {{getBlock(x,y,z):number, setBlock(x,y,z,id):void, isLoadedAt(x,z):boolean}} world
   * @param {(x:number,y:number,z:number,blockId:number)=>void} [onDestroy] called before water replaces a plant
   */
  constructor(world, onDestroy = null) {
    this.world = world;
    this.onDestroy = onDestroy;
    /** "x,y,z" keys scheduled for the next tick. */
    this.pending = new Set();
    /** chunk "cx,cz" → Set of keys waiting for that chunk to load. */
    this.deferred = new Map();
    /** Keys whose flow comes from a generated cave spring: written without recording an edit. */
    this.natural = new Set();
    this.currentNatural = false;
    this.updatesLastTick = 0;
  }

  get pendingCount() { return this.pending.size; }

  /** Forget every scheduled update (leaving / entering a world). */
  clear() {
    this.pending.clear();
    this.deferred.clear();
    this.natural.clear();
    this.currentNatural = false;
    this.updatesLastTick = 0;
  }

  schedule(x, y, z, natural = this.currentNatural) {
    if (y < 0 || y > 255) return;
    const key = x + ',' + y + ',' + z;
    this.pending.add(key);
    if (natural) this.natural.add(key); else this.natural.delete(key);
  }

  /** A block changed: the block and its six neighbours may need a water update. */
  onBlockChanged(x, y, z) {
    this.schedule(x, y, z);
    this.schedule(x + 1, y, z); this.schedule(x - 1, y, z);
    this.schedule(x, y + 1, z); this.schedule(x, y - 1, z);
    this.schedule(x, y, z + 1); this.schedule(x, y, z - 1);
  }

  /** A chunk finished loading: resume updates that were waiting for it and start its cave springs flowing. */
  onChunkLoaded(cx, cz) {
    const key = cx + ',' + cz;
    const chunk = this.world.getChunk(cx, cz);
    if (chunk && chunk.springs) {
      const s = chunk.springs;
      for (let i = 0; i + 2 < s.length; i += 3) this.schedule(cx * 16 + s[i], s[i + 1], cz * 16 + s[i + 2], true);
    }
    const waiting = this.deferred.get(key);
    if (!waiting) return;
    this.deferred.delete(key);
    for (const k of waiting) this.pending.add(k);
  }

  /** Process one scheduled tick (call every WATER_TICK_SECONDS). */
  tick() {
    if (this.pending.size === 0) { this.updatesLastTick = 0; return; }
    const batch = this.pending;
    this.pending = new Set();
    let n = 0;
    for (const key of batch) {
      if (n >= MAX_WATER_UPDATES_PER_TICK) { this.pending.add(key); continue; }
      const [x, y, z] = key.split(',').map(Number);
      if (!this.world.isLoadedAt(x, z)) { this._defer(x, z, key); continue; }
      this.currentNatural = this.natural.delete(key);
      this.update(x, y, z);
      this.currentNatural = false;
      n++;
    }
    this.updatesLastTick = n;
  }

  _solid(id) { return SOLID[id] === 1; }

  /** Water may enter air and plants (anything replaceable that is not water). */
  _canFlowInto(id) {
    return id === B.AIR || (!this._solid(id) && !isWater(id) && RENDER_TYPE[id] === RenderType.CROSS);
  }

  /** Park an update until the chunk containing (x, z) loads. */
  _defer(x, z, key) {
    const ck = (x >> 4) + ',' + (z >> 4);
    if (!this.deferred.has(ck)) this.deferred.set(ck, new Set());
    this.deferred.get(ck).add(key);
  }

  /**
   * Put water at a target block. If the target's chunk isn't loaded, the *flowing* block's update is
   * deferred until it loads, so the flow resumes at chunk borders instead of being lost.
   */
  _set(x, y, z, id, fromKey) {
    if (!this.world.isLoadedAt(x, z)) { if (fromKey) this._defer(x, z, fromKey); return false; }
    const cur = this.world.getBlock(x, y, z);
    if (cur !== B.AIR && !isWater(cur) && this.onDestroy) this.onDestroy(x, y, z, cur);
    this.world.setBlock(x, y, z, id, !this.currentNatural);
    return true;
  }

  /** Recompute one water block, then let it flow. */
  update(x, y, z) {
    let id = this.world.getBlock(x, y, z);
    if (!isWater(id)) return;
    const w = this.world;
    const key = x + ',' + y + ',' + z;
    const above = w.getBlock(x, y + 1, z);
    const below = w.getBlock(x, y - 1, z);

    // 1. Level from the surroundings (sources never change on their own).
    if (!isSource(id)) {
      let next;
      if (isWater(above)) next = B.FALLING_WATER;
      else {
        let min = WATER_MAX_LEVEL + 1, sources = 0;
        for (const [dx, dz] of DIRS) {
          const n = w.getBlock(x + dx, y, z + dz);
          if (!isWater(n)) continue;
          min = Math.min(min, levelOf(n));
          if (isSource(n)) sources++;
        }
        if (sources >= 2 && (this._solid(below) || isSource(below))) next = B.WATER;      // infinite source
        else if (min + 1 > WATER_MAX_LEVEL) next = B.AIR;                                  // nothing feeds it: dry up
        else next = flowingId(min + 1);
      }
      if (next !== id) {
        w.setBlock(x, y, z, next, !this.currentNatural);
        if (next === B.AIR) return;
        id = next;
      }
    }

    // 2. Down first: fall into anything replaceable.
    if (y > 0 && this._canFlowInto(below)) {
      this._set(x, y - 1, z, B.FALLING_WATER, key);
      return;
    }
    // 3. Sideways only from a source or when resting on something solid (falling water in mid-air does not).
    if (!(isSource(id) || this._solid(below))) return;
    const next = levelOf(id) + 1;
    if (next > WATER_MAX_LEVEL) return;
    const dirs = this._flowDirections(x, y, z);
    for (const [dx, dz] of dirs) {
      const nx = x + dx, nz = z + dz;
      const n = w.getBlock(nx, y, nz);
      if (this._canFlowInto(n) || (isWater(n) && !isSource(n) && !isFalling(n) && levelOf(n) > next)) {
        this._set(nx, y, nz, flowingId(next), key);
      }
    }
  }

  /** Neighbour is passable for spreading: not solid and not source water. */
  _passable(id) { return !this._solid(id) && !(isWater(id) && isSource(id)); }

  /** Directions with the shortest path to a drop within WATER_SLOPE_SEARCH blocks (all passable ones if none). */
  _flowDirections(x, y, z) {
    const w = this.world;
    let best = NO_SLOPE;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const [dx, dz] = DIRS[i];
      const n = w.getBlock(x + dx, y, z + dz);
      if (!this._passable(n)) continue;
      const belowN = w.getBlock(x + dx, y - 1, z + dz);
      const dist = this._solid(belowN) ? this._slopeDistance(x + dx, y, z + dz, 1, i) : 0;
      if (dist < best) { out.length = 0; best = dist; }
      if (dist <= best) out.push(DIRS[i]);
    }
    return out;
  }

  _slopeDistance(x, y, z, distance, fromDir) {
    const w = this.world;
    let best = NO_SLOPE;
    for (let i = 0; i < 4; i++) {
      if ((i ^ 1) === fromDir) continue; // don't walk back where we came from (DIRS pairs are opposites)
      const [dx, dz] = DIRS[i];
      const n = w.getBlock(x + dx, y, z + dz);
      if (!this._passable(n)) continue;
      if (!this._solid(w.getBlock(x + dx, y - 1, z + dz))) return distance;
      if (distance < WATER_SLOPE_SEARCH) best = Math.min(best, this._slopeDistance(x + dx, y, z + dz, distance + 1, i));
    }
    return best;
  }

  /**
   * Flow direction of the water at a block (unit vector or zero), for pushing entities.
   * out: {x, y, z}
   */
  flowVector(x, y, z, out) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    out.x = 0; out.y = 0; out.z = 0;
    if (!isWater(id)) return out;
    const decay = levelOf(id);
    for (const [dx, dz] of DIRS) {
      const n = w.getBlock(x + dx, y, z + dz);
      let k = 0;
      if (isWater(n)) k = levelOf(n) - decay;
      else if (!this._solid(n)) {
        const under = w.getBlock(x + dx, y - 1, z + dz);
        if (isWater(under)) k = levelOf(under) - (decay - 8);
      }
      out.x += dx * k; out.z += dz * k;
    }
    if (isFalling(id)) out.y -= 6;
    const len = Math.hypot(out.x, out.y, out.z);
    if (len > 0) { out.x /= len; out.y /= len; out.z /= len; }
    return out;
  }
}
