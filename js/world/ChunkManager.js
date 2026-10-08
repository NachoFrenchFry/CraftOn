// ChunkManager.js — streams chunks around the player: prioritized generation in a worker pool,
// meshing in a worker pool once all neighbours exist, budgeted integration per frame, unloading.

import { WorkerPool } from './WorkerPool.js';
import { Chunk, ChunkState } from './Chunk.js';
import { chunkKey, keyToChunkX, keyToChunkZ } from './ChunkCoords.js';
import { buildPaddedChunk, allocPadded } from './ChunkPadding.js';
import { INTEGRATION_BUDGET_MS, MAX_MESH_UPLOADS_PER_FRAME, UNLOAD_MARGIN, GENERATION_MARGIN } from '../config/Constants.js';
import { LightUpdater, LIGHT_BUDGET_MS } from './lighting/LightUpdater.js';
import { chunkTop } from './lighting/SkyLight.js';

const NEIGHBOR_OFFSETS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

export class ChunkManager {
  /**
   * @param {import('./World.js').World} world
   * @param {import('../rendering/ChunkMeshManager.js').ChunkMeshManager} meshManager
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(world, meshManager, settings) {
    this.world = world;
    this.meshManager = meshManager;
    this.settings = settings;
    const cores = navigator.hardwareConcurrency || 4;
    this.genPool = new WorkerPool(new URL('../generation/generation.worker.js', import.meta.url), Math.max(1, Math.min(4, cores - 1)));
    this.meshPool = new WorkerPool(new URL('../rendering/meshing.worker.js', import.meta.url), Math.max(1, Math.min(2, cores - 2)));
    this.genQueue = [];
    this.genInFlight = new Set();
    this.genResults = [];
    this.meshCheck = new Set();
    this.meshInFlight = new Set();
    this.meshResults = [];
    /** Voxel lighting (Update #10): chunks waiting for their worker light pass, jobs in flight, results to apply. */
    this.lightCheck = new Set();
    this.lightInFlight = new Set();
    this.lightResults = [];
    this.lightTiming = { total: 0, count: 0 };
    this.lightPhases = { columns: 0, seeds: 0, bfs: 0, copy: 0, seeded: 0 };
    this.lightUpdater = new LightUpdater(world);
    world.lightUpdater = this.lightUpdater;
    this.centerCX = null;
    this.centerCZ = null;
    this.generation = 0; // bumped on clear() so stale worker replies are ignored
    this.queuesDirty = true;
    /** Worker timing accumulators (for the debug overlay). */
    this.genTiming = { total: 0, count: 0 };
    this.meshTiming = { total: 0, count: 0 };
  }

  get renderDistance() { return this.settings.get('renderDistance'); }
  /** [mesh uploads per frame, integration budget ms] for the Chunk Updates setting (Update #9 §7). */
  get uploadBudget() { const v = this.settings.get('chunkUpdates'); return v === 'low' ? [2, 2] : v === 'high' ? [MAX_MESH_UPLOADS_PER_FRAME * 2 + 2, INTEGRATION_BUDGET_MS * 2] : [MAX_MESH_UPLOADS_PER_FRAME, INTEGRATION_BUDGET_MS]; }
  /** Generation radius: covers every neighbour (diagonals included) of every chunk in the render circle. */
  get genRadius() { return this.renderDistance + GENERATION_MARGIN; }
  /** Chunks farther than this from the player are unloaded. Always larger than genRadius. */
  get unloadRadius() { return this.genRadius + UNLOAD_MARGIN; }

  setSeed(seed) {
    this.genPool.broadcast({ type: 'init', seed });
  }

  /** Mirror the atlas' transparency overrides in the mesh workers (main-thread mesher shares the registry). */
  setCutoutBlocks(ids) {
    this.meshPool.broadcast({ type: 'init', cutoutBlocks: ids });
  }

  /** Drop every chunk, mesh and pending job. */
  clear() {
    this.generation++;
    this.genQueue.length = 0;
    this.genInFlight.clear();
    this.genResults.length = 0;
    this.meshCheck.clear();
    this.meshInFlight.clear();
    this.meshResults.length = 0;
    this.lightCheck.clear();
    this.lightInFlight.clear();
    this.lightResults.length = 0;
    this.lightUpdater.clear();
    this.meshManager.removeAll();
    this.world.chunks.clear();
    this.centerCX = null;
    this.centerCZ = null;
    this.queuesDirty = true;
  }

  /** Force queue recomputation (e.g. render distance changed). */
  invalidate() { this.queuesDirty = true; }

  /**
   * After bulk block writes straight into chunk arrays (tests, tools): recompute the light of every chunk touching
   * the world-space rectangle plus a one-chunk margin (their padded borders copy these chunks) and remesh them.
   */
  relightRegion(x0, z0, x1, z1) {
    for (let cz = (Math.min(z0, z1) >> 4) - 1; cz <= (Math.max(z0, z1) >> 4) + 1; cz++) for (let cx = (Math.min(x0, x1) >> 4) - 1; cx <= (Math.max(x0, x1) >> 4) + 1; cx++) {
      const chunk = this.world.getChunk(cx, cz);
      if (!chunk) continue;
      chunk.recountSections();
      chunk.lit = false; chunk.light = null; chunk.lighting = false; chunk.lightDirty = 0; chunk.remeshMask = 0;
      chunk.meshed = false; chunk.version++;
      this.lightCheck.add(chunkKey(cx, cz)); this.meshCheck.add(chunkKey(cx, cz));
    }
  }

  /** Re-mesh everything (AO toggle). */
  remeshAll() {
    for (const chunk of this.world.chunks.values()) chunk.remeshMask = 0;
    this.meshManager.invalidateAll();
    for (const key of this.world.chunks.keys()) this.meshCheck.add(key);
  }

  /** Per-frame driver. dirX/dirZ = horizontal view direction for priority bonus. */
  update(px, pz, dirX, dirZ) {
    const cx = Math.floor(px) >> 4, cz = Math.floor(pz) >> 4;
    if (this.queuesDirty || cx !== this.centerCX || cz !== this.centerCZ) {
      this.centerCX = cx; this.centerCZ = cz;
      this.queuesDirty = false;
      this._recompute(cx, cz, dirX, dirZ);
    }
    this._dispatchGeneration();
    this._integrate();
    this.lightUpdater.update(LIGHT_BUDGET_MS);
    this._queueLightRemeshes();
    this._dispatchLighting();
    this._dispatchMeshing();
  }

  /** Sections whose light changed get a partial remesh (worker job limited to those sections). */
  _queueLightRemeshes() {
    const dirty = this.lightUpdater.dirtyChunks;
    if (!dirty.size) return;
    for (const key of dirty) {
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;
      // Only sections whose light changed: a partial job; the chunk stays "meshed" (no version bump, so a full job in
      // flight is kept) and bits that arrive while the job runs simply queue the next one.
      if (chunk.meshed && chunk.lightDirty) { chunk.remeshMask |= chunk.lightDirty; this.meshCheck.add(key); }
      chunk.lightDirty = 0;
    }
    dirty.clear();
  }

  /** Initial lighting in the worker once a chunk and its eight neighbours have block data (a 3×3 grid is exact). */
  _dispatchLighting() {
    const maxInFlight = this.meshPool.size + this.genPool.size;
    if (this.lightInFlight.size >= maxInFlight || this.lightCheck.size === 0) return;
    const reach = this.renderDistance + 1;
    for (const key of this.lightCheck) {
      if (this.lightInFlight.size >= maxInFlight) break;
      const chunk = this.world.chunks.get(key);
      if (!chunk || chunk.lit || chunk.lighting) { this.lightCheck.delete(key); continue; }
      if (!this._withinRadius(chunk.cx, chunk.cz, reach)) continue;
      if (!this._hasAllNeighbors(chunk.cx, chunk.cz)) continue;
      this.lightCheck.delete(key);
      chunk.lighting = true;
      this.lightInFlight.add(key);
      const grid = [], tops = [], transfer = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const n = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
        if (n) { const copy = n.blocks.slice(); grid.push(copy); tops.push(chunkTop(n)); transfer.push(copy.buffer); } else { grid.push(null); tops.push(0); }
      }
      const gen = this.generation;
      const pool = this.genPool.inFlight <= this.meshPool.inFlight ? this.genPool : this.meshPool; // both pools run light jobs
      pool.post({ type: 'light', cx: chunk.cx, cz: chunk.cz, grid, tops, version: chunk.version }, transfer).then((r) => {
        if (gen !== this.generation) return;
        this.lightTiming.total += r.ms || 0; this.lightTiming.count++;
        if (r.phases) for (const k of Object.keys(this.lightPhases)) this.lightPhases[k] += r.phases[k] || 0;
        this.lightResults.push(r);
      });
    }
  }

  _recompute(cx, cz, dirX, dirZ) {
    const genR = this.genRadius;
    const unloadR = this.unloadRadius;
    const span = Math.ceil(genR);
    // Unload far chunks.
    for (const key of [...this.world.chunks.keys()]) {
      const dx = keyToChunkX(key) - cx, dz = keyToChunkZ(key) - cz;
      if (dx * dx + dz * dz > unloadR * unloadR) {
        if (this.world.events) this.world.events.emit('chunk:unloading', keyToChunkX(key), keyToChunkZ(key));
        this.meshManager.removeChunk(keyToChunkX(key), keyToChunkZ(key));
        this.world.chunks.delete(key);
        this.meshCheck.delete(key);
      }
    }
    // Rebuild the generation queue, nearest first with a bonus for chunks in view.
    const len = Math.hypot(dirX, dirZ) || 1;
    const vx = dirX / len, vz = dirZ / len;
    const queue = [];
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > genR * genR) continue;
        const key = chunkKey(cx + dx, cz + dz);
        if (this.world.chunks.has(key) || this.genInFlight.has(key)) continue;
        const d = Math.sqrt(d2);
        const dot = d > 0 ? (dx * vx + dz * vz) / d : 1;
        queue.push({ cx: cx + dx, cz: cz + dz, key, priority: d - Math.max(0, dot) * 2.5 });
      }
    }
    queue.sort((a, b) => a.priority - b.priority);
    this.genQueue = queue;
    // Re-check meshing candidates in the new radius.
    for (const key of this.world.chunks.keys()) {
      const chunk = this.world.chunks.get(key);
      if (!chunk.meshed && !chunk.meshing) this.meshCheck.add(key);
    }
  }

  _dispatchGeneration() {
    const maxInFlight = this.genPool.size * 3;
    while (this.genInFlight.size < maxInFlight && this.genQueue.length) {
      const job = this.genQueue.shift();
      if (this.world.chunks.has(job.key)) continue;
      this.genInFlight.add(job.key);
      const gen = this.generation;
      this.genPool.post({ type: 'generate', cx: job.cx, cz: job.cz, seed: this.world.seed }).then((r) => {
        if (gen !== this.generation) return;
        this.genTiming.total += r.ms || 0; this.genTiming.count++;
        this.genResults.push(r);
      });
    }
  }

  _withinRadius(cx, cz, r) {
    const dx = cx - this.centerCX, dz = cz - this.centerCZ;
    return dx * dx + dz * dz <= r * r;
  }

  _integrate() {
    const start = performance.now();
    let uploads = 0;
    const [maxUploads, budgetMs] = this.uploadBudget;
    while (this.lightResults.length && performance.now() - start < budgetMs) {
      const r = this.lightResults.shift();
      const key = chunkKey(r.cx, r.cz);
      this.lightInFlight.delete(key);
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;
      chunk.lighting = false;
      if (chunk.version !== r.version) { this.lightCheck.add(key); continue; } // edited meanwhile: light it again
      chunk.light = r.light;
      chunk.lit = true;
      this.lightUpdater.onChunkLit(chunk);
      this.meshCheck.add(key);
    }
    while (this.meshResults.length && uploads < maxUploads && performance.now() - start < budgetMs) {
      const r = this.meshResults.shift();
      const key = chunkKey(r.cx, r.cz);
      this.meshInFlight.delete(key);
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;
      chunk.meshing = false;
      if (chunk.version !== r.version) { this.meshCheck.add(key); continue; }
      this.meshManager.applyChunkResult(r.cx, r.cz, r, r.sectionMask);
      chunk.meshed = true;
      chunk.dirtySections = 0;
      uploads++;
    }
    while (this.genResults.length && performance.now() - start < budgetMs) {
      const r = this.genResults.shift();
      const key = chunkKey(r.cx, r.cz);
      this.genInFlight.delete(key);
      if (this.world.chunks.has(key)) continue;
      if (this.centerCX !== null && !this._withinRadius(r.cx, r.cz, this.unloadRadius)) continue;
      const chunk = new Chunk(r.cx, r.cz, r.blocks);
      chunk.heightMap.set(r.heightMap);
      chunk.biomeMap.set(r.biomeMap);
      chunk.springs = r.springs && r.springs.length ? r.springs : null;
      chunk.state = ChunkState.GENERATED;
      this.world.edits.applyTo(chunk);
      chunk.recountSections();
      chunk.version = 0;
      this.world.chunks.set(key, chunk);
      this.lightCheck.add(key);
      this.meshCheck.add(key);
      if (this.world.events) this.world.events.emit('chunk:loaded', r.cx, r.cz);
      for (const [dx, dz] of NEIGHBOR_OFFSETS) {
        const nk = chunkKey(r.cx + dx, r.cz + dz);
        const n = this.world.chunks.get(nk);
        if (n) { this.meshCheck.add(nk); if (!n.lit && !n.lighting) this.lightCheck.add(nk); }
      }
    }
  }

  _hasAllNeighbors(cx, cz) {
    for (const [dx, dz] of NEIGHBOR_OFFSETS) if (!this.world.chunks.has(chunkKey(cx + dx, cz + dz))) return false;
    return true;
  }

  _dispatchMeshing() {
    const maxInFlight = this.meshPool.size * 2;
    if (this.meshInFlight.size >= maxInFlight || this.meshCheck.size === 0) return;
    const rd = this.renderDistance;
    const ao = this.settings.get('smoothLighting');
    const fastLeaves = !this.settings.get('fancyLeaves');
    for (const key of this.meshCheck) {
      if (this.meshInFlight.size >= maxInFlight) break;
      const chunk = this.world.chunks.get(key);
      if (!chunk) { this.meshCheck.delete(key); continue; }
      if ((chunk.meshed && !chunk.remeshMask) || chunk.meshing) { this.meshCheck.delete(key); continue; }
      if (!this._withinRadius(chunk.cx, chunk.cz, rd)) continue;
      if (!this._hasAllNeighbors(chunk.cx, chunk.cz)) continue;
      if (!chunk.lit) continue; // lighting runs first (the light pass is queued by _dispatchLighting)
      this.meshCheck.delete(key);
      chunk.meshing = true;
      this.meshInFlight.add(key);
      const padded = allocPadded();
      buildPaddedChunk(this.world, chunk.cx, chunk.cz, padded);
      const light = chunk.light.slice();
      const partial = chunk.meshed && chunk.remeshMask; // a lit-section refresh of an existing mesh
      const sectionMask = partial ? (chunk.remeshMask & chunk.nonEmptyMask()) : chunk.nonEmptyMask();
      chunk.remeshMask = 0;
      if (partial && !sectionMask) { chunk.meshing = false; this.meshInFlight.delete(key); continue; }
      const msg = { type: 'mesh', cx: chunk.cx, cz: chunk.cz, padded, light, sectionMask, ao, fastLeaves, version: chunk.version };
      const gen = this.generation;
      this.meshPool.post(msg, [padded.buffer, light.buffer]).then((r) => {
        if (gen !== this.generation) return;
        this.meshTiming.total += r.ms || 0; this.meshTiming.count++;
        this.meshResults.push(r);
      });
    }
  }

  /** True when the chunk at world (x, z) has block data. */
  isGeneratedAt(x, z) {
    return this.world.chunks.has(chunkKey(Math.floor(x) >> 4, Math.floor(z) >> 4));
  }

  /** Fraction (0..1) of chunks within `radius` of (cx, cz) that are meshed. */
  progress(cx, cz, radius) {
    let total = 0, done = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        total++;
        const chunk = this.world.chunks.get(chunkKey(cx + dx, cz + dz));
        if (chunk && chunk.meshed) done++;
      }
    }
    return total ? done / total : 1;
  }

  stats() {
    let ready = 0;
    const rd = this.renderDistance;
    for (const key of this.meshCheck) {
      const chunk = this.world.chunks.get(key);
      if (chunk && this.centerCX !== null && this._withinRadius(chunk.cx, chunk.cz, rd) && this._hasAllNeighbors(chunk.cx, chunk.cz)) ready++;
    }
    return {
      loaded: this.world.chunks.size,
      meshes: this.meshManager.meshCount,
      meshPending: ready + this.meshInFlight.size + this.meshResults.length,
      genQueue: this.genQueue.length + this.genInFlight.size,
      lightPending: [...this.lightCheck].filter((k) => { const c = this.world.chunks.get(k); return c && this.centerCX !== null && this._withinRadius(c.cx, c.cz, rd + 1) && this._hasAllNeighbors(c.cx, c.cz); }).length + this.lightInFlight.size + this.lightResults.length,
      lightInFlight: this.lightInFlight.size,
      lightQueue: this.lightUpdater.pending,
    };
  }

  dispose() {
    this.genPool.terminate();
    this.meshPool.terminate();
  }
}
