// WaterSimulation.js — Minecraft-style scheduled liquid updates: flow down as falling liquid, spread
// sideways with weakening levels (water 7 blocks on flat ground, lava 3), prefer directions that lead to a
// drop within 4 blocks, recede when cut off, form infinite sources (water only), destroy plants and torches.
// Only scheduled blocks are ever touched, so still oceans cost nothing. The same class runs lava (Update #11)
// with the `lava` kind: a slower tick (Game), no new sources, and the owner's rule that lava touching water
// (any level, either way round) becomes cobblestone. Pure logic over a world interface; runs in Node for tests.

import { BlockIds as B } from '../blocks/BlockIds.js';
import { SOLID, RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';
import { isWater, isSource, isFalling, levelOf, flowingId, isLava, isLavaSource, isLavaFalling, lavaLevelOf, lavaFlowingId, LAVA_MAX_LEVEL, isLiquid } from './WaterLevels.js';
import { MAX_WATER_UPDATES_PER_TICK, WATER_SLOPE_SEARCH, WATER_MAX_LEVEL } from '../config/Constants.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NO_SLOPE = 1000;

/** The two liquids: block predicates, level helpers, how far they spread and whether sources form. */
export const LIQUID_KINDS = Object.freeze({
  water: Object.freeze({ name: 'water', is: isWater, isSource, isFalling, levelOf, flowingId, source: B.WATER, falling: B.FALLING_WATER, maxLevel: WATER_MAX_LEVEL, infiniteSources: true, springs: true }),
  lava: Object.freeze({ name: 'lava', is: isLava, isSource: isLavaSource, isFalling: isLavaFalling, levelOf: lavaLevelOf, flowingId: lavaFlowingId, source: B.LAVA, falling: B.FALLING_LAVA, maxLevel: LAVA_MAX_LEVEL, infiniteSources: false, springs: false }),
});

export class WaterSimulation {
  /**
   * @param {{getBlock(x,y,z):number, setBlock(x,y,z,id):void, isLoadedAt(x,z):boolean}} world
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
    /** "x,y,z" keys scheduled for the next tick. */
    this.pending = new Set();
    /** Update #9 §7: scheduled cells farther than simRadius from the player wait (simulation distance). */
    this.simCenter = null;
    this.simRadius = Infinity;
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

  /**
   * A block changed: the block and its six neighbours may need an update — but only the cells that hold this liquid
   * are scheduled (a stale entry would still cost one of the MAX_WATER_UPDATES_PER_TICK slots; with two simulations
   * sharing every block change, the slow lava tick would otherwise be starved by water's flow).
   */
  onBlockChanged(x, y, z) {
    const w = this.world, K = this.kind;
    if (K.is(w.getBlock(x, y, z))) this.schedule(x, y, z);
    if (K.is(w.getBlock(x + 1, y, z))) this.schedule(x + 1, y, z);
    if (K.is(w.getBlock(x - 1, y, z))) this.schedule(x - 1, y, z);
    if (y + 1 < 256 && K.is(w.getBlock(x, y + 1, z))) this.schedule(x, y + 1, z);
    if (y > 0 && K.is(w.getBlock(x, y - 1, z))) this.schedule(x, y - 1, z);
    if (K.is(w.getBlock(x, y, z + 1))) this.schedule(x, y, z + 1);
    if (K.is(w.getBlock(x, y, z - 1))) this.schedule(x, y, z - 1);
  }

  /** A chunk finished loading: resume updates that were waiting for it and start its cave springs flowing. */
  onChunkLoaded(cx, cz) {
    const key = cx + ',' + cz;
    const chunk = this.world.getChunk(cx, cz);
    if (this.kind.springs && chunk && chunk.springs) {
      const s = chunk.springs;
      for (let i = 0; i + 2 < s.length; i += 3) this.schedule(cx * 16 + s[i], s[i + 1], cz * 16 + s[i + 2], true);
    }
    const waiting = this.deferred.get(key);
    if (!waiting) return;
    this.deferred.delete(key);
    for (const k of waiting) this.pending.add(k);
  }

  setSimulationCenter(x, z) { if (!this.simCenter) this.simCenter = { x, z }; else { this.simCenter.x = x; this.simCenter.z = z; } }

  /** Process one scheduled tick (call every WATER_TICK_SECONDS). */
  tick() {
    if (this.pending.size === 0) { this.updatesLastTick = 0; return; }
    const batch = this.pending;
    this.pending = new Set();
    let n = 0;
    const c = this.simCenter, r = this.simRadius;
    for (const key of batch) {
      if (n >= MAX_WATER_UPDATES_PER_TICK) { this.pending.add(key); continue; }
      const [x, y, z] = key.split(',').map(Number);
      if (c && r !== Infinity && Math.hypot(x - c.x, z - c.z) > r) { this.pending.add(key); continue; } // outside the simulation distance: wait
      if (!this.world.isLoadedAt(x, z)) { this._defer(x, z, key); continue; }
      this.currentNatural = this.natural.delete(key);
      this.update(x, y, z);
      this.currentNatural = false;
      n++;
    }
    this.updatesLastTick = n;
  }

  _solid(id) { return SOLID[id] === 1; }

  /** A liquid may enter air, plants and torches (anything replaceable that is not a liquid). */
  _canFlowInto(id) {
    if (id === B.AIR) return true;
    if (this._solid(id) || isLiquid(id)) return false;
    const rt = RENDER_TYPE[id];
    return rt === RenderType.CROSS || rt === RenderType.TORCH;
  }

  /** Owner's rule (Update #11): a lava block touching water on any of its six sides becomes cobblestone. Returns true when it did. */
  _quench(x, y, z) {
    const w = this.world;
    if (!isLava(w.getBlock(x, y, z))) return false;
    const touching = isWater(w.getBlock(x + 1, y, z)) || isWater(w.getBlock(x - 1, y, z)) || isWater(w.getBlock(x, y, z + 1)) || isWater(w.getBlock(x, y, z - 1))
      || isWater(w.getBlock(x, y + 1, z)) || (y > 0 && isWater(w.getBlock(x, y - 1, z)));
    if (!touching) return false;
    w.setBlock(x, y, z, B.COBBLESTONE, true);
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
    if (cur !== B.AIR && !isLiquid(cur) && this.onDestroy) this.onDestroy(x, y, z, cur);
    this.world.setBlock(x, y, z, id, !this.currentNatural);
    if (this.kind.name === 'water') this._quenchAround(x, y, z); else if (this._quench(x, y, z)) return false;
    return true;
  }

  /** Recompute one liquid block of this kind, then let it flow. */
  update(x, y, z) {
    const K = this.kind;
    let id = this.world.getBlock(x, y, z);
    if (!K.is(id)) return;
    const w = this.world;
    // Lava next to water is cobblestone before anything else; water next to lava quenches it (the water stays).
    if (K.name === 'lava') { if (this._quench(x, y, z)) return; } else this._quenchAround(x, y, z);
    const key = x + ',' + y + ',' + z;
    const above = w.getBlock(x, y + 1, z);
    const below = w.getBlock(x, y - 1, z);

    // 1. Level from the surroundings (sources never change on their own).
    if (!K.isSource(id)) {
      let next;
      if (K.is(above)) next = K.falling;
      else {
        let min = K.maxLevel + 1, sources = 0;
        for (const [dx, dz] of DIRS) {
          const n = w.getBlock(x + dx, y, z + dz);
          if (!K.is(n)) continue;
          min = Math.min(min, K.levelOf(n));
          if (K.isSource(n)) sources++;
        }
        if (K.infiniteSources && sources >= 2 && (this._solid(below) || K.isSource(below))) next = K.source; // infinite source (water only)
        else if (min + 1 > K.maxLevel) next = B.AIR;                                                          // nothing feeds it: dry up
        else next = K.flowingId(min + 1);
      }
      if (next !== id) {
        w.setBlock(x, y, z, next, !this.currentNatural);
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
    for (const [dx, dz] of dirs) {
      const nx = x + dx, nz = z + dz;
      const n = w.getBlock(nx, y, nz);
      if (this._canFlowInto(n) || (K.is(n) && !K.isSource(n) && !K.isFalling(n) && K.levelOf(n) > next)) {
        this._set(nx, y, nz, K.flowingId(next), key);
      }
    }
  }

  /** Neighbour is passable for spreading: not solid, not the other liquid and not a source of this one. */
  _passable(id) { return !this._solid(id) && !(isLiquid(id) && !this.kind.is(id)) && !(this.kind.is(id) && this.kind.isSource(id)); }

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
    const w = this.world, K = this.kind;
    const id = w.getBlock(x, y, z);
    out.x = 0; out.y = 0; out.z = 0;
    if (!K.is(id)) return out;
    const decay = K.levelOf(id);
    for (const [dx, dz] of DIRS) {
      const n = w.getBlock(x + dx, y, z + dz);
      let k = 0;
      if (K.is(n)) k = K.levelOf(n) - decay;
      else if (!this._solid(n)) {
        const under = w.getBlock(x + dx, y - 1, z + dz);
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
