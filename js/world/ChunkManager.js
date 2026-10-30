// ChunkManager.js — streams chunks around the player: prioritized generation in a worker pool,
// meshing in a worker pool once all neighbours exist, budgeted integration per frame, unloading.
// A job the pool rejects (the worker replied with an error, crashed, or timed out) clears its in-flight entry and
// flags and is queued again with a backoff (1 s, 2 s, 4 s); after three failures the chunk is marked failed (logged
// once with its coordinates, the job type and the error). A watchdog
// (every 2 s) looks for chunks inside the render distance that have not reached "meshed" about 10 s after they were
// needed and resets whatever they were stuck in; F3 shows the stuck / retried / failed counts (`stats().health`).

import { WorkerPool } from './WorkerPool.js';
import { Chunk, ChunkState } from './Chunk.js';
import { chunkKey, keyToChunkX, keyToChunkZ } from './ChunkCoords.js';
import { buildPaddedChunk, allocPadded } from './ChunkPadding.js';
import { INTEGRATION_BUDGET_MS, MAX_MESH_UPLOADS_PER_FRAME, UNLOAD_MARGIN, GENERATION_MARGIN } from '../config/Constants.js';
import { LightUpdater, LIGHT_BUDGET_MS } from './lighting/LightUpdater.js';
import { chunkTop } from './lighting/SkyLight.js';

const NEIGHBOR_OFFSETS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
/** Failed jobs: retried after 1 s, 2 s, 4 s, then the chunk is marked failed. The watchdog runs every WATCHDOG_MS and resets a chunk not done STUCK_MS after it was needed. */
const RETRY_BASE_MS = 1000, MAX_RETRIES = 3, WATCHDOG_MS = 2000, STUCK_MS = 10000;

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
    // Workers: one pool of chunk workers (generation, the initial light pass and meshing in one script) with up
    // to hardwareConcurrency − 1 workers, at most 6, so a 4-core laptop runs 3 and an 8-core desktop 6; every job goes to the
    // idlest worker. `genPool` / `meshPool` are the same pool (kept as names for the dispatch caps and the overlay).
    const cores = navigator.hardwareConcurrency || 4;
    this.pool = new WorkerPool(new URL('./chunk.worker.js', import.meta.url), Math.max(2, Math.min(6, cores - 1)), { label: 'chunk' });
    { const pool = this.pool;
      pool.onError = (info) => { if (info.kind !== 'error') console.warn(`ChunkManager: ${pool.label} worker ${info.worker} ${info.kind}: ${info.message}`); };
      pool.onReplaced = (index, reason) => console.warn(`ChunkManager: ${pool.label} worker ${index} replaced (${reason}); its jobs are retried`);
    }
    /** Failed jobs per chunk: key → { generate, light, mesh, failed, error }; `retries` are due re-queues; the watchdog's bookkeeping. */
    this.failures = new Map();
    this.retries = [];
    this.health = { retried: 0, failed: 0, stuck: 0 };
    /** The pool request id of every job in flight, per kind (key → id): the watchdog can tell a lost job from a pending one. */
    this.jobIds = { generate: new Map(), light: new Map(), mesh: new Map() };
    this.needed = new Map();
    this.stuckKeys = new Set();
    this._watchdogAt = 0;
    this.lastProgressAt = 0;
    this.genPool = this.pool;
    this.meshPool = this.pool;
    this.genQueue = [];
    this.genInFlight = new Set();
    this.genResults = [];
    this.meshCheck = new Set();
    this.meshInFlight = new Set();
    this.meshResults = [];
    /** Voxel lighting: chunks waiting for their worker light pass, jobs in flight, results to apply. */
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
    /** Chunks integrated this frame whose 'chunk:loaded' fan-out (springs, mobs) still has to run: drained within the budget. */
    this.loadedQueue = [];
    this._candidates = [];
    /** Worker timing accumulators (for the debug overlay). */
    this.genTiming = { total: 0, count: 0 };
    /** Worker mesh time per job; `sections` (an array when a tool turns timing on) collects the per-section milliseconds. */
    this.meshTiming = { total: 0, count: 0, sections: null };
    /** Padded block copies and light copies that came back from the workers, ready for the next mesh job. */
    this._paddedFree = [];
    this._lightFree = [];
    /** How far flat opaque faces merge in the worker: 'greedy' (2D), 'strips' (1D) or 'faces' (none); the bench and the sparkle test switch it. */
    this.meshMode = 'greedy';
    /** Structure chests get their generated loot written into WorldEdits when the chunk first arrives (false on guests: the host owns chests). */
    this.applyGeneratedLoot = true;
  }

  get renderDistance() { return this.settings.get('renderDistance'); }
  /** [mesh uploads per frame, integration budget ms] for the Chunk Updates setting. */
  get uploadBudget() { const v = this.settings.get('chunkUpdates'); return v === 'low' ? [2, 2] : v === 'high' ? [MAX_MESH_UPLOADS_PER_FRAME * 2 + 2, INTEGRATION_BUDGET_MS * 2] : [MAX_MESH_UPLOADS_PER_FRAME, INTEGRATION_BUDGET_MS]; }
  /** Generation radius: covers every neighbour (diagonals included) of every chunk in the render circle. */
  get genRadius() { return this.renderDistance + GENERATION_MARGIN; }
  /** Chunks farther than this from the player are unloaded. Always larger than genRadius. */
  get unloadRadius() { return this.genRadius + UNLOAD_MARGIN; }

  setSeed(seed) {
    this.pool.broadcast({ type: 'init', seed });
  }


  /** /locate in a chunk worker (no chunks generated): resolves with { x, y, z, distance } or null (also on a worker failure, logged). */
  locate(kind, name, x, z, maxDist) {
    return this.pool.post({ type: 'locate', kind, name, x, z, seed: this.world.seed, maxDist }).then((r) => r.found || null).catch((e) => { console.warn('ChunkManager: locate failed', e); return null; });
  }

  /** Mirror the atlas' transparency overrides in the workers (main-thread mesher shares the registry). */
  setCutoutBlocks(ids) {
    this.pool.broadcast({ type: 'init', cutoutBlocks: ids });
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
    this.loadedQueue.length = 0;
    this.failures.clear(); this.retries.length = 0; this.needed.clear(); this.stuckKeys.clear();
    for (const m of Object.values(this.jobIds)) m.clear();
    this.lightUpdater.clear();
    this.meshManager.removeAll();
    this.world.chunks.clear();
    this.centerCX = null;
    this.centerCZ = null;
    this.queuesDirty = true;
  }

  // ---- failed, retried and stuck jobs ----
  /** Marked failed after MAX_RETRIES failures of one job kind. */
  isFailed(key) { const f = this.failures.get(key); return !!(f && f.failed); }
  /** Waiting for its retry backoff. */
  isRetrying(key) { for (const r of this.retries) if (r.key === key) return true; return false; }
  /** Forget the failed chunks (a console / test helper): they are queued again. */
  retryFailed() {
    for (const [key, f] of this.failures) if (f.failed) { this.failures.delete(key); const c = this.world.chunks.get(key); if (c) { if (!c.lit) this.lightCheck.add(key); this.meshCheck.add(key); } }
    this.queuesDirty = true;
  }
  /**
   * A worker job was rejected (an error reply, a crashed worker, a timeout): clear the in-flight entry and flags, log once
   * per chunk and job kind, queue it again after a backoff, and mark the chunk failed after MAX_RETRIES tries.
   */
  _jobFailed(kind, key, cx, cz, err, extra = null) {
    const chunk = this.world.chunks.get(key);
    this.jobIds[kind].delete(key);
    if (kind === 'generate') { if (!this.genInFlight.has(key)) return; this.genInFlight.delete(key); }
    else if (kind === 'light') { if (!this.lightInFlight.has(key)) return; this.lightInFlight.delete(key); if (chunk) chunk.lighting = false; }
    else if (kind === 'mesh') { if (!this.meshInFlight.has(key)) return; this.meshInFlight.delete(key); if (chunk) { chunk.meshing = false; if (extra && extra.partial) chunk.remeshMask |= extra.sectionMask; } }
    const f = this.failures.get(key) || { generate: 0, light: 0, mesh: 0, failed: false, error: null };
    f[kind]++; f.error = err.message; this.failures.set(key, f);
    const n = f[kind];
    if (n > MAX_RETRIES) {
      f.failed = true; this.health.failed++;
      console.error(`ChunkManager: ${kind} job for chunk ${cx},${cz} failed ${n} times, marked failed: ${err.message}`, err.workerStack || '');
      return;
    }
    const delay = RETRY_BASE_MS << (n - 1);
    this.health.retried++;
    if (n === 1) console.warn(`ChunkManager: ${kind} job for chunk ${cx},${cz} failed: ${err.message}; retrying in ${delay} ms (up to ${MAX_RETRIES} tries)`, err.workerStack || '');
    this.retries.push({ key, kind, at: performance.now() + delay });
  }
  _runRetries(now) {
    if (!this.retries.length) return;
    const keep = [];
    for (const r of this.retries) {
      if (r.at > now) { keep.push(r); continue; }
      if (r.kind === 'generate') this.queuesDirty = true;
      else if (this.world.chunks.has(r.key)) { if (r.kind === 'light') this.lightCheck.add(r.key); else this.meshCheck.add(r.key); }
    }
    this.retries = keep;
  }
  /**
   * Every WATCHDOG_MS: every chunk inside the render distance should be meshed (inside the generation radius: generated)
   * within STUCK_MS of being needed. One that is not, and is neither waiting its turn behind moving work nor retrying nor
   * failed, is logged with its full state, reset (in-flight entries and flags cleared) and queued again.
   */
  _watchdog(now) {
    const cx = this.centerCX, cz = this.centerCZ;
    if (cx === null) return;
    const rd = this.renderDistance, genR = this.genRadius, span = Math.ceil(genR);
    const moving = now - this.lastProgressAt < STUCK_MS; // results keep landing: queued work is just waiting for a slot
    for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > genR * genR) continue;
      const key = chunkKey(cx + dx, cz + dz), chunk = this.world.chunks.get(key), inRd = d2 <= rd * rd;
      const done = chunk ? (chunk.meshed || !inRd) : false;
      if (done || this.isFailed(key) || this.isRetrying(key)) { this.needed.delete(key); this.stuckKeys.delete(key); continue; }
      const since = this.needed.get(key);
      if (since === undefined) { this.needed.set(key, now); continue; }
      if (now - since < STUCK_MS) continue;
      const state = {
        generated: !!chunk, lit: !!(chunk && chunk.lit), lighting: !!(chunk && chunk.lighting), meshed: !!(chunk && chunk.meshed), meshing: !!(chunk && chunk.meshing),
        genInFlight: this.genInFlight.has(key), lightInFlight: this.lightInFlight.has(key), meshInFlight: this.meshInFlight.has(key),
        inGenQueue: this.genQueue.some((j) => j.key === key), inLightCheck: this.lightCheck.has(key), inMeshCheck: this.meshCheck.has(key),
        neighbours: chunk ? this._hasAllNeighbors(chunk.cx, chunk.cz) : false, failures: this.failures.get(key) || null,
      };
      const inFlight = state.genInFlight || state.lightInFlight || state.meshInFlight;
      const queued = state.inGenQueue || state.inLightCheck || state.inMeshCheck;
      // Waiting its turn (queued, or in a worker's queue) while results keep landing is not stuck: the pool's own timeout
      // catches a job that never answers. Stuck is an "in flight" entry whose request the pool no longer holds and
      // whose result is not waiting to be integrated (lost), a chunk the pipeline has dropped (neither queued nor in
      // flight), or anything at all once nothing has landed for STUCK_MS.
      const lost = (state.genInFlight && !this._jobAlive('generate', key, this.genResults)) || (state.lightInFlight && !this._jobAlive('light', key, this.lightResults)) || (state.meshInFlight && !this._jobAlive('mesh', key, this.meshResults));
      state.lost = lost;
      if (!lost && (inFlight || queued) && moving) { this.needed.set(key, now); continue; }
      this.health.stuck++; this.stuckKeys.add(key);
      console.warn(`ChunkManager watchdog: chunk ${cx + dx},${cz + dz} not ${inRd ? 'meshed' : 'generated'} ${Math.round((now - since) / 1000)} s after it was needed — reset and queued again`, JSON.stringify(state));
      this.genInFlight.delete(key); this.lightInFlight.delete(key); this.meshInFlight.delete(key);
      if (chunk) { chunk.lighting = false; chunk.meshing = false; if (!chunk.lit) this.lightCheck.add(key); this.meshCheck.add(key); }
      else this.queuesDirty = true;
      this.needed.set(key, now);
    }
    for (const key of [...this.needed.keys()]) { const ddx = keyToChunkX(key) - cx, ddz = keyToChunkZ(key) - cz; if (ddx * ddx + ddz * ddz > genR * genR) { this.needed.delete(key); this.stuckKeys.delete(key); } }
  }
  /** An in-flight job of this kind is still pending in the pool, or its result waits for integration. */
  _jobAlive(kind, key, results) {
    const id = this.jobIds[kind].get(key);
    if (id !== undefined && this.pool.pending.has(id)) return true;
    for (const r of results) if (chunkKey(r.cx, r.cz) === key) return true;
    return false;
  }
  /** The job-health counts for F3 and the benchmark report. */
  healthSummary() {
    const a = this.pool.stats;
    return { stuck: this.health.stuck, retried: this.health.retried, retriesPending: this.retries.length, failed: this.health.failed, errors: a.errors, crashes: a.crashes, timeouts: a.timeouts, replaced: a.replaced, lastError: a.lastError };
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
      chunk.meshed = false; chunk.revision++;
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
    const now = performance.now();
    this._runRetries(now);
    if (now - this._watchdogAt > WATCHDOG_MS) { this._watchdogAt = now; this._watchdog(now); }
    if (this.queuesDirty || cx !== this.centerCX || cz !== this.centerCZ) {
      this.centerCX = cx; this.centerCZ = cz;
      this.queuesDirty = false;
      this._recompute(cx, cz, dirX, dirZ);
    }
    const pr = this.world.profiler;
    if (pr) pr.begin('chunks');
    this._dispatchGeneration();
    if (pr) pr.end('chunks');
    if (pr) pr.begin('integrate');
    this._integrate();
    if (pr) pr.end('integrate');
    if (pr) pr.begin('light');
    this.lightUpdater.update(LIGHT_BUDGET_MS);
    if (pr) pr.end('light');
    if (pr) pr.begin('chunks');
    this._queueLightRemeshes();
    this._queueDirtyRemeshes();
    this._dispatchLighting();
    if (pr) pr.end('chunks');
    if (pr) pr.begin('meshing');
    this._dispatchMeshing();
    if (pr) pr.end('meshing');
  }

  /** Sections marked dirty by block changes since the last frame: queue their chunks for a partial worker job. */
  _queueDirtyRemeshes() {
    const dirty = this.meshManager.dirtyChunks;
    if (!dirty.size) return;
    for (const key of dirty) if (this.world.chunks.has(key)) this.meshCheck.add(key);
    dirty.clear();
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
    const maxInFlight = this.pool.size;
    if (this.lightInFlight.size >= maxInFlight || this.lightCheck.size === 0) return;
    const reach = this.renderDistance + 1;
    for (const key of this.lightCheck) {
      if (this.lightInFlight.size >= maxInFlight) break;
      const chunk = this.world.chunks.get(key);
      if (!chunk || chunk.lit || chunk.lighting || this.isFailed(key)) { this.lightCheck.delete(key); continue; }
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
      const lmsg = { type: 'light', cx: chunk.cx, cz: chunk.cz, grid, tops, revision: chunk.revision };
      const lp = this.pool.post(lmsg, transfer);
      this.jobIds.light.set(key, lmsg.id);
      lp.then((r) => {
        if (gen !== this.generation) return;
        this.jobIds.light.delete(key);
        this.lightTiming.total += r.ms || 0; this.lightTiming.count++;
        if (r.phases) for (const k of Object.keys(this.lightPhases)) this.lightPhases[k] += r.phases[k] || 0;
        this.lightResults.push(r);
      }).catch((e) => { if (gen === this.generation) this._jobFailed('light', key, chunk.cx, chunk.cz, e); });
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
        if (this.world.chunks.has(key) || this.genInFlight.has(key) || this.isFailed(key) || this.isRetrying(key)) continue;
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
    const maxInFlight = this.pool.size * 2;
    while (this.genInFlight.size < maxInFlight && this.genQueue.length) {
      const job = this.genQueue.shift();
      if (this.world.chunks.has(job.key)) continue;
      this.genInFlight.add(job.key);
      const gen = this.generation;
      const gmsg = { type: 'generate', cx: job.cx, cz: job.cz, seed: this.world.seed };
      const gp = this.pool.post(gmsg);
      this.jobIds.generate.set(job.key, gmsg.id);
      gp.then((r) => {
        if (gen !== this.generation) return;
        this.jobIds.generate.delete(job.key);
        this.genTiming.total += r.ms || 0; this.genTiming.count++;
        this.genResults.push(r);
      }).catch((e) => { if (gen === this.generation) this._jobFailed('generate', job.key, job.cx, job.cz, e); });
    }
  }

  _withinRadius(cx, cz, r) {
    const dx = cx - this.centerCX, dz = cz - this.centerCZ;
    return dx * dx + dz * dz <= r * r;
  }

  _integrate() {
    const pr = this.world.profiler;
    const start = performance.now();
    let uploads = 0;
    const [maxUploads, budgetMs] = this.uploadBudget;
    if (this.lightResults.length || this.meshResults.length || this.genResults.length) this.lastProgressAt = start;
    while (this.lightResults.length && performance.now() - start < budgetMs) {
      const r = this.lightResults.shift();
      const key = chunkKey(r.cx, r.cz);
      this.lightInFlight.delete(key);
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;
      chunk.lighting = false;
      chunk.light = r.light;
      chunk.lit = true;
      if (pr) pr.begin('light');
      this.lightUpdater.onChunkLit(chunk); // replays edits made while the job ran and queues the seam slices (budgeted in update())
      if (pr) pr.end('light');
      this.meshCheck.add(key);
    }
    while (this.meshResults.length && uploads < maxUploads && performance.now() - start < budgetMs) {
      const r = this.meshResults.shift();
      const key = chunkKey(r.cx, r.cz);
      this.meshInFlight.delete(key);
      const chunk = this.world.chunks.get(key);
      if (!chunk) { this._recycle(r); continue; }
      chunk.meshing = false;
      if (pr) pr.begin('meshing');
      this.meshManager.applyChunkResult(r.cx, r.cz, r, r.sectionMask, r.revisions);
      if (pr) pr.end('meshing');
      this._recycle(r);
      if (!chunk.meshed && this.world.events) this.world.events.emit('chunk:meshed', r.cx, r.cz);
      chunk.meshed = true;
      if (chunk.remeshMask) this.meshCheck.add(key); // sections edited while the job ran: the next (partial) job
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
      if (r.containers && r.containers.length && this.applyGeneratedLoot) this.world.edits.applyGenerated(r.cx, r.cz, r.containers);
      this.world.edits.applyTo(chunk);
      chunk.recountSections();
      chunk.revision = 0;
      this.world.chunks.set(key, chunk);
      this.lightCheck.add(key);
      this.meshCheck.add(key);
      this.loadedQueue.push(key);
      for (const [dx, dz] of NEIGHBOR_OFFSETS) {
        const nk = chunkKey(r.cx + dx, r.cz + dz);
        const n = this.world.chunks.get(nk);
        if (n) { this.meshCheck.add(nk); if (!n.lit && !n.lighting) this.lightCheck.add(nk); }
      }
    }
    // The 'chunk:loaded' fan-out (cave springs, stowed mobs, the first mob group) counts against the same budget; what does not
    // fit waits for the next frame.
    while (this.loadedQueue.length && performance.now() - start < budgetMs) {
      const key = this.loadedQueue.shift();
      if (!this.world.chunks.has(key)) continue;
      if (pr) pr.begin('chunkLoaded');
      if (this.world.events) this.world.events.emit('chunk:loaded', keyToChunkX(key), keyToChunkZ(key));
      if (pr) pr.end('chunkLoaded');
    }
  }

  _hasAllNeighbors(cx, cz) {
    const chunks = this.world.chunks;
    for (let i = 0; i < NEIGHBOR_OFFSETS.length; i++) { const o = NEIGHBOR_OFFSETS[i]; if (!chunks.has(chunkKey(cx + o[0], cz + o[1]))) return false; }
    return true;
  }

  _dispatchMeshing() {
    const maxInFlight = this.pool.size * 2;
    if (this.meshInFlight.size >= maxInFlight || this.meshCheck.size === 0) return;
    const rd = this.renderDistance;
    const ao = this.settings.get('smoothLighting');
    const fastLeaves = !this.settings.get('fancyLeaves');
    // Eligible chunks: those without any mesh yet first (a chunk refreshed every tick by nearby water must never starve one
    // that has never been drawn), then nearest the player first.
    const cand = this._candidates;
    cand.length = 0;
    for (const key of this.meshCheck) {
      const chunk = this.world.chunks.get(key);
      if (!chunk || this.isFailed(key)) { this.meshCheck.delete(key); continue; }
      if ((chunk.meshed && !chunk.remeshMask) || chunk.meshing) { this.meshCheck.delete(key); continue; }
      if (!this._withinRadius(chunk.cx, chunk.cz, rd)) continue;
      if (!chunk.lit) continue; // lighting runs first (the light pass is queued by _dispatchLighting)
      if (!this._hasAllNeighbors(chunk.cx, chunk.cz)) continue;
      cand.push(chunk);
    }
    if (cand.length > 1) {
      const ccx = this.centerCX, ccz = this.centerCZ;
      cand.sort((a, b) => (a.meshed - b.meshed) || (((a.cx - ccx) ** 2 + (a.cz - ccz) ** 2) - ((b.cx - ccx) ** 2 + (b.cz - ccz) ** 2)));
    }
    for (let i = 0; i < cand.length && this.meshInFlight.size < maxInFlight; i++) {
      const chunk = cand[i];
      const key = chunkKey(chunk.cx, chunk.cz);
      this.meshCheck.delete(key);
      const partial = chunk.meshed && chunk.remeshMask; // a refresh of some sections of an existing mesh
      const sectionMask = partial ? chunk.remeshMask : chunk.nonEmptyMask();
      chunk.remeshMask = 0;
      if (!sectionMask) continue;
      chunk.meshing = true;
      this.meshInFlight.add(key);
      // The padded copy and the light copy come back with the result (transferred both ways), so steady-state meshing allocates nothing.
      const padded = this._paddedFree.pop() || allocPadded();
      buildPaddedChunk(this.world, chunk.cx, chunk.cz, padded);
      let light = this._lightFree.pop();
      if (!light || light.length !== chunk.light.length) light = new Uint8Array(chunk.light.length);
      light.set(chunk.light);
      const revisions = Array.from(chunk.sectionRevisions);
      const msg = { type: 'mesh', cx: chunk.cx, cz: chunk.cz, padded, light, sectionMask, ao, fastLeaves, revision: chunk.revision, mode: this.meshMode, timing: this.meshTiming.sections !== null };
      const gen = this.generation;
      const mp = this.pool.post(msg, [padded.buffer, light.buffer]);
      this.jobIds.mesh.set(key, msg.id);
      mp.then((r) => {
        if (gen !== this.generation) { this._recycle(r); return; }
        this.jobIds.mesh.delete(key);
        this.meshTiming.total += r.ms || 0; this.meshTiming.count++;
        if (this.meshTiming.sections && r.sectionMs) for (const ms of r.sectionMs) this.meshTiming.sections.push(ms);
        r.revisions = revisions;
        this.meshResults.push(r);
      }).catch((e) => { if (gen === this.generation) this._jobFailed('mesh', key, chunk.cx, chunk.cz, e, { partial, sectionMask }); });
    }
    cand.length = 0;
  }

  /**
   * A mesh result's buffers go back where they came from: the padded / light copies to the free lists (the next job
   * fills them) and every section's pass buffers to the worker that produced them (transferred), so it allocates nothing
   * for the next chunk.
   */
  _recycle(r) {
    const keep = this.pool.size * 2 + 2;
    if (r.padded && r.padded.length && this._paddedFree.length < keep) this._paddedFree.push(r.padded);
    if (r.light && r.light.length && this._lightFree.length < keep) this._lightFree.push(r.light);
    const buffers = [];
    if (r.sections) for (const s of r.sections) for (const name of ['opaque', 'cutout', 'translucent', 'lava']) {
      const pass = s[name];
      if (!pass) continue;
      if (pass.data && pass.data.buffer.byteLength) buffers.push(pass.data.buffer);
      if (pass.yf && pass.yf.buffer.byteLength) buffers.push(pass.yf.buffer);
    }
    r.sections = null;
    if (buffers.length && r.worker !== undefined) this.pool.send(r.worker, { type: 'recycle', buffers }, buffers);
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
      health: this.healthSummary(),
    };
  }

  dispose() {
    this.pool.terminate();
  }
}
