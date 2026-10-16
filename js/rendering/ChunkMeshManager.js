// ChunkMeshManager.js — owns the THREE meshes of the loaded chunks: uploads worker results, performs the
// synchronous re-mesh of a player's own edit, marks sections dirty for everything else and
// disposes geometry when chunks unload.
//
// One mesh per chunk per render pass (opaque, cutout, translucent, lava): a chunk's pass geometry is the concatenation
// of its sections' packed vertices (PackedVertex.js: 8 bytes each, liquids plus a float height), in section order, and
// the manager keeps every section's vertex / index range, so the visibility walk (Visibility.js) draws just the index
// span of the sections it reached. Every chunk mesh has a tight bounding box for frustum culling.
//
// No per-edit reallocation: a pass buffer is sized to a size class with headroom (ArrayPool.js) and a section change
// rewrites the buffer from that section on (the sections before it keep their place), uploading only that tail
// (`addUpdateRange`); the buffer is reallocated — one class up — only when the pass outgrows it. Freed buffers go back
// to the pool. The quads of every chunk share ONE index buffer (the 0,1,2, 0,2,3 pattern), sized for the biggest mesh.

import * as THREE from 'three';
import { SECTION_COUNT, SECTION_SIZE, CHUNK_SIZE } from '../config/Constants.js';
import { chunkKey } from '../world/ChunkCoords.js';
import { buildPaddedChunk, allocPadded } from '../world/ChunkPadding.js';
import { meshSection, MeshBuilders, computeVisMask } from './ChunkMesher.js';
import { createChunkMaterials } from './Materials.js';
import { ArrayPool, sizeClass } from '../utils/ArrayPool.js';
import { BYTES_PER_VERTEX } from './PackedVertex.js';

export const PASS_NAMES = ['opaque', 'cutout', 'translucent', 'lava'];
/** Passes whose vertices carry the float height attribute. */
const LIQUID_PASS = { opaque: false, cutout: false, translucent: true, lava: true };
/** Per section and pass: [vertexStart, vertexCount, indexStart, indexCount]. */
const R = 4;
/** Headroom over the vertex count when a pass buffer is (re)allocated, before rounding up to a size class. */
const HEADROOM = 1.5;
/** Quads the shared index covers at first (131072 vertices); it doubles when a chunk pass needs more. */
const INITIAL_INDEX_QUADS = 32768;

/** The GPU buffers of one chunk pass: a Uint32 pair per vertex (+ float y for liquids), `cap` vertices of room. */
class PassBuffer {
  constructor(cap, data, yf) {
    this.cap = cap;
    this.used = 0;
    this.data = new THREE.BufferAttribute(data, 2);
    this.data.gpuType = THREE.IntType;
    this.data.setUsage(THREE.DynamicDrawUsage);
    this.yf = yf ? new THREE.BufferAttribute(yf, 1) : null;
    if (this.yf) this.yf.setUsage(THREE.DynamicDrawUsage);
  }
  get bytes() { return this.cap * (BYTES_PER_VERTEX + (this.yf ? 4 : 0)); }
}

/** The render data of one loaded chunk. */
class ChunkEntry {
  constructor(cx, cz, chunk) {
    this.cx = cx; this.cz = cz;
    this.chunk = chunk;
    this.meshes = { opaque: null, cutout: null, translucent: null, lava: null };
    this.buffers = { opaque: null, cutout: null, translucent: null, lava: null };
    this.ranges = { opaque: new Int32Array(SECTION_COUNT * R), cutout: new Int32Array(SECTION_COUNT * R), translucent: new Int32Array(SECTION_COUNT * R), lava: new Int32Array(SECTION_COUNT * R) };
    /** Visibility walk bookkeeping (Visibility.js): per-section stamp of the frame that reached it; the reached span. */
    this.visStamp = new Uint32Array(SECTION_COUNT);
    this.visFrame = 0;
    this.visLo = 0; this.visHi = 0;
  }
}

export class ChunkMeshManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/World.js').World} world
   * @param {import('./TextureAtlas.js').TextureAtlas} atlas
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(scene, world, atlas, settings) {
    this.scene = scene;
    this.world = world;
    this.settings = settings;
    this.materials = createChunkMaterials(atlas.arrayTexture);
    /** The plain set; `materials` points at the shader pipeline's lit set while shaders are on. */
    this.baseMaterials = this.materials;
    this.litDepth = null;
    this.lit = false;
    /** packed chunk key → ChunkEntry */
    this.entries = new Map();
    this.scratchPadded = allocPadded();
    this.builders = new MeshBuilders();
    /**
     * The mesher mode of the instant (main-thread) remesh after a player edit: 1D strips (merge along one axis), whose
     * worst case is about 2–3× cheaper than full greedy merging on a cliff; with `hybridInstant` the edited section is
     * then queued for the worker, whose greedy mesh (ChunkManager.meshMode) replaces the strips a few frames later —
     * edits stay instant, the final mesh stays optimal, and the two draw the same pixels.
     */
    this.instantMode = 'strips';
    this.hybridInstant = true;
    /** Bumped whenever any chunk geometry is rebuilt or removed (the shadow maps re-render only when something changed). */
    this.geometryVersion = 0;
    /** World-space bounds (blocks) of every geometry change since the shadow pipeline last looked (`any` false = none). */
    this.changeBounds = { any: false, minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    this.meshCount = 0;
    /** Chunk keys with `remeshMask` bits set since the last frame; ChunkManager drains it. */
    this.dirtyChunks = new Set();
    /** Culling statistics for F3 (Visibility.js writes them). */
    this.stats = { sections: 0, visible: 0, chunksVisible: 0, spanTriangles: 0, reachedTriangles: 0 };
    /** Pass buffers by size class: a chunk that unloads hands its arrays to the next one that loads. */
    this.pools = { data: new ArrayPool(Uint32Array, 96 << 20), yf: new ArrayPool(Float32Array, 16 << 20) };
    /** Counters for tests and the bench: pass rebuilds that fit in place vs. ones that needed a bigger buffer. */
    this.inPlaceUpdates = 0;
    this.reallocations = 0;
    /** The one index buffer every chunk mesh draws with. */
    this.sharedIndex = null;
    this._ensureIndex(INITIAL_INDEX_QUADS * 4);
    this._replace = new Array(SECTION_COUNT).fill(undefined);
    this._bySy = new Array(SECTION_COUNT).fill(null);
    this._counts = new Int32Array(SECTION_COUNT);
    world.meshManager = this;
  }

  get useAO() { return this.settings.get('smoothLighting'); }
  /** Fast leaves: opaque leaf blocks with the faces between them culled. */
  get fastLeaves() { return !this.settings.get('fancyLeaves'); }

  _entry(cx, cz, create) {
    const key = chunkKey(cx, cz);
    let entry = this.entries.get(key);
    if (!entry && create) {
      entry = new ChunkEntry(cx, cz, this.world.getChunk(cx, cz));
      this.entries.set(key, entry);
    }
    return entry || null;
  }

  /** The shared quad index covers at least `vertices` vertices (grown by doubling; every chunk geometry is re-pointed). */
  _ensureIndex(vertices) {
    const quads = Math.ceil(vertices / 4);
    if (this.sharedIndex && this.sharedIndex.count >= quads * 6) return;
    let n = this.sharedIndex ? this.sharedIndex.count / 6 : INITIAL_INDEX_QUADS;
    while (n < quads) n *= 2;
    const idx = new Uint32Array(n * 6);
    for (let q = 0, i = 0, v = 0; q < n; q++, v += 4) { idx[i++] = v; idx[i++] = v + 1; idx[i++] = v + 2; idx[i++] = v; idx[i++] = v + 2; idx[i++] = v + 3; }
    this.sharedIndex = new THREE.BufferAttribute(idx, 1);
    for (const entry of this.entries.values()) for (const name of PASS_NAMES) { const m = entry.meshes[name]; if (m) m.geometry.setIndex(this.sharedIndex); }
  }

  /** Drop a pass geometry's GPU buffers without touching the shared index (Three would delete it with the geometry). */
  _disposeGeometry(geom) {
    geom.index = null;
    geom.dispose();
  }

  /** Widen the change bounds by a chunk's column (y0..y1 block rows). */
  _noteChange(entry, y0, y1) {
    const b = this.changeBounds, x0 = entry.cx * CHUNK_SIZE, z0 = entry.cz * CHUNK_SIZE;
    if (!b.any) { b.any = true; b.minX = x0; b.maxX = x0 + CHUNK_SIZE; b.minY = y0; b.maxY = y1; b.minZ = z0; b.maxZ = z0 + CHUNK_SIZE; return; }
    if (x0 < b.minX) b.minX = x0; if (x0 + CHUNK_SIZE > b.maxX) b.maxX = x0 + CHUNK_SIZE;
    if (y0 < b.minY) b.minY = y0; if (y1 > b.maxY) b.maxY = y1;
    if (z0 < b.minZ) b.minZ = z0; if (z0 + CHUNK_SIZE > b.maxZ) b.maxZ = z0 + CHUNK_SIZE;
  }

  /** The shadow pipeline took note of the changes: start collecting afresh. */
  clearChangeBounds() { this.changeBounds.any = false; }

  _disposeMesh(entry, name) {
    const mesh = entry.meshes[name];
    if (!mesh) return;
    this._noteChange(entry, mesh.geometry.boundingBox ? mesh.geometry.boundingBox.min.y : 0, mesh.geometry.boundingBox ? mesh.geometry.boundingBox.max.y : SECTION_COUNT * SECTION_SIZE);
    this.scene.remove(mesh);
    this._disposeGeometry(mesh.geometry);
    const buf = entry.buffers[name];
    if (buf) { this.pools.data.release(buf.data.array); if (buf.yf) this.pools.yf.release(buf.yf.array); }
    entry.meshes[name] = null;
    entry.buffers[name] = null;
    this.meshCount--;
  }

  _geometryFor(buf) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('data', buf.data); // the packed vertex (PackedVertex.js)
    if (buf.yf) geom.setAttribute('yf', buf.yf); // liquid corner heights
    geom.setIndex(this.sharedIndex);
    return geom;
  }

  /**
   * Rebuild one pass of a chunk: `replace[sy]` is a section's new pass data ({ data, yf, vertexCount }), null to drop
   * that section, undefined to keep what the buffers hold. The buffer is rewritten from the first changed section on
   * (earlier sections keep their place) and only that tail is uploaded; a pass that no longer fits moves to a bigger
   * pooled buffer and a fresh geometry.
   */
  _rebuildPass(entry, name, replace) {
    const r = entry.ranges[name];
    const counts = this._counts;
    let verts = 0, lo = -1, hi = -1, first = -1;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const d = replace[sy];
      const oldC = r[sy * R + 1];
      const c = d === undefined ? oldC : d ? d.vertexCount : 0;
      if (first < 0 && d !== undefined && (c || oldC)) first = verts; // its old start: everything before it is unchanged
      counts[sy] = c;
      verts += c;
      if (c) { if (lo < 0) lo = sy; hi = sy; }
    }
    if (first < 0) return; // nothing changed
    this.geometryVersion++;
    { // the rows that change: every replaced section (old and new extents)
      let y0 = Infinity, y1 = -Infinity;
      for (let sy = 0; sy < SECTION_COUNT; sy++) if (replace[sy] !== undefined && (counts[sy] || r[sy * R + 1])) { if (sy * SECTION_SIZE < y0) y0 = sy * SECTION_SIZE; if ((sy + 1) * SECTION_SIZE > y1) y1 = (sy + 1) * SECTION_SIZE; }
      if (y0 <= y1) this._noteChange(entry, y0, y1);
    }
    if (!verts) { this._disposeMesh(entry, name); r.fill(0); return; }
    let buf = entry.buffers[name];
    const liquid = LIQUID_PASS[name];
    const grow = !buf || verts > buf.cap;
    const src = buf ? buf.data.array : null, srcY = buf && buf.yf ? buf.yf.array : null;
    let dst, dstY = null;
    if (grow) {
      const cap = sizeClass(Math.ceil(verts * HEADROOM));
      dst = this.pools.data.acquire(cap * 2);
      if (liquid) dstY = this.pools.yf.acquire(cap);
      this.reallocations++;
      this._ensureIndex(cap);
      // The unchanged head is copied below like everything else; the old arrays go back to the pool afterwards.
    } else {
      // Rewrite in place: the head stays, the tail is moved / written and uploaded. Sections after a changed one shift,
      // so the kept ones are copied through a pooled scratch array of the same class (a memmove) and the arrays swap.
      dst = this.pools.data.acquire(buf.cap * 2);
      if (liquid) dstY = this.pools.yf.acquire(buf.cap);
      this.inPlaceUpdates++;
    }
    if (first > 0) { dst.set(src.subarray(0, first * 2)); if (dstY) dstY.set(srcY.subarray(0, first)); }
    let v = first;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const d = replace[sy];
      const vs = r[sy * R], vc = r[sy * R + 1], c = counts[sy];
      if (vs < first && d === undefined) { continue; } // kept, before the first change: already in place
      if (d === undefined) {
        if (vc) { dst.set(src.subarray(vs * 2, (vs + vc) * 2), v * 2); if (dstY) dstY.set(srcY.subarray(vs, vs + vc), v); }
      } else if (d) {
        dst.set(d.data, v * 2);
        if (dstY) { if (d.yf) dstY.set(d.yf, v); else dstY.fill(0, v, v + c); }
      }
      r[sy * R] = v; r[sy * R + 1] = c; r[sy * R + 2] = v / 4 * 6; r[sy * R + 3] = c / 4 * 6;
      v += c;
    }
    const y0 = lo * SECTION_SIZE, y1 = (hi + 1) * SECTION_SIZE;
    let mesh = entry.meshes[name];
    if (grow) {
      const old = buf;
      buf = new PassBuffer(dst.length / 2, dst, dstY);
      entry.buffers[name] = buf;
      const geom = this._geometryFor(buf);
      if (mesh) { this._disposeGeometry(mesh.geometry); mesh.geometry = geom; }
      else {
        mesh = new THREE.Mesh(geom, this.materials[name]);
        mesh.position.set(entry.cx * CHUNK_SIZE, 0, entry.cz * CHUNK_SIZE);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.frustumCulled = true;
        mesh.castShadow = this.lit; mesh.receiveShadow = this.lit;
        if (this.litDepth) mesh.customDepthMaterial = this.litDepth[name];
        mesh.name = 'section';
        this.scene.add(mesh);
        this.meshCount++;
        entry.meshes[name] = mesh;
      }
      if (old) { this.pools.data.release(old.data.array); if (old.yf) this.pools.yf.release(old.yf.array); }
    } else {
      buf.data.array = dst; this.pools.data.release(src);
      buf.data.addUpdateRange(first * 2, (verts - first) * 2); buf.data.needsUpdate = true;
      if (buf.yf) { buf.yf.array = dstY; this.pools.yf.release(srcY); buf.yf.addUpdateRange(first, verts - first); buf.yf.needsUpdate = true; }
    }
    buf.used = verts;
    const geom = mesh.geometry;
    if (!geom.boundingBox) { geom.boundingBox = new THREE.Box3(); geom.boundingSphere = new THREE.Sphere(); }
    geom.boundingBox.min.set(0, y0, 0); geom.boundingBox.max.set(CHUNK_SIZE, y1, CHUNK_SIZE);
    geom.boundingSphere.center.set(8, (y0 + y1) / 2, 8); geom.boundingSphere.radius = Math.sqrt(128 + ((y1 - y0) / 2) ** 2);
    const dr = geom.drawRange;
    if (dr.start + dr.count > verts / 4 * 6) geom.setDrawRange(0, verts / 4 * 6); // the visibility walk re-applies its span next frame
  }

  /** Shaders on: every chunk mesh switches to the lit materials and takes part in shadows; null restores the plain set. */
  setLitMaterials(lit) {
    this.lit = !!lit;
    this.materials = lit || this.baseMaterials;
    this.litDepth = lit && lit.depth ? lit.depth : null; // the shadow depth pass per pass (waving + tile-array alpha test)
    for (const entry of this.entries.values()) {
      for (const name of PASS_NAMES) {
        const m = entry.meshes[name];
        if (!m) continue;
        m.material = this.materials[name]; m.castShadow = this.lit; m.receiveShadow = this.lit;
        if (this.litDepth) m.customDepthMaterial = this.litDepth[name]; else delete m.customDepthMaterial;
      }
    }
  }

  /** Replace one section's pass buffers (any pass may be null) and rebuild the chunk's affected pass meshes. */
  applySection(cx, cz, sy, passes) {
    const entry = this._entry(cx, cz, true);
    const rep = this._replace;
    for (const name of PASS_NAMES) {
      rep.fill(undefined);
      rep[sy] = passes[name] || null;
      if (rep[sy] === null && entry.ranges[name][sy * R + 1] === 0) continue; // nothing there before either
      this._rebuildPass(entry, name, rep);
    }
  }

  /**
   * Apply a worker result ({ sections: [{sy, opaque, cutout, translucent, lava, visMask}] }) for the sections in `sectionMask`,
   * rebuilding each chunk pass once. A section edited since the job was posted (`revisions` = the per-section counters at post
   * time) and not flagged dirty again was re-meshed synchronously meanwhile: its fresh mesh is kept. Returns the mask skipped.
   */
  applyChunkResult(cx, cz, result, sectionMask, revisions = null) {
    const entry = this._entry(cx, cz, true);
    const chunk = this.world.getChunk(cx, cz);
    let skipped = 0;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const bit = 1 << sy;
      if (!(sectionMask & bit)) continue;
      if (revisions && chunk && chunk.sectionRevisions[sy] !== revisions[sy] && !(chunk.remeshMask & bit)) skipped |= bit;
    }
    const bySy = this._bySy;
    bySy.fill(null);
    for (const s of result.sections) { bySy[s.sy] = s; if (chunk && !(skipped & (1 << s.sy)) && s.visMask !== undefined) chunk.visMask[s.sy] = s.visMask; }
    const rep = this._replace;
    for (const name of PASS_NAMES) {
      let any = false;
      rep.fill(undefined);
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        const bit = 1 << sy;
        if (!(sectionMask & bit) || (skipped & bit)) continue;
        const s = bySy[sy];
        const d = s ? s[name] || null : null;
        rep[sy] = d;
        if (d || entry.ranges[name][sy * R + 1]) any = true;
      }
      if (any) this._rebuildPass(entry, name, rep);
    }
    return skipped;
  }

  /** Remove and dispose every mesh of a chunk. */
  removeChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.geometryVersion++;
    for (const name of PASS_NAMES) this._disposeMesh(entry, name);
    this.entries.delete(key);
  }

  removeAll() {
    this.geometryVersion++;
    for (const entry of this.entries.values()) for (const name of PASS_NAMES) this._disposeMesh(entry, name);
    this.entries.clear();
  }

  /** Synchronously re-mesh one section on the main thread (a player's own edit). Returns false when the chunk has no mesh yet. */
  remeshSectionNow(cx, cz, sy) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk || !chunk.meshed) return false;
    const y0 = sy * SECTION_SIZE;
    buildPaddedChunk(this.world, cx, cz, this.scratchPadded, y0 - 1, y0 + SECTION_SIZE); // only the layers this section reads
    this.builders.reset();
    if (chunk.sectionCounts[sy] > 0) meshSection(this.scratchPadded, sy, this.useAO, this.builders, this.fastLeaves, chunk.lit ? chunk.light : null, this.instantMode);
    chunk.visMask[sy] = computeVisMask(this.scratchPadded, sy);
    this.applySection(cx, cz, sy, this.builders.results(null)); // views into the builders: copied into the chunk buffers at once
    chunk.dirtySections &= ~(1 << sy);
    chunk.lightDirty &= ~(1 << sy); // the mesh just built has the current light of this section
    chunk.remeshMask &= ~(1 << sy);
    return true;
  }

  /** Flag a section for a worker re-mesh (ChunkManager drains `dirtyChunks` every frame, nearest first, one job per section at most). */
  markDirty(cx, cz, sy) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk) return;
    const bit = 1 << sy;
    if (chunk.remeshMask & bit) return;
    chunk.remeshMask |= bit;
    this.dirtyChunks.add(chunkKey(cx, cz));
  }

  /**
   * Called by World.setBlock for every block change. The edited section is re-meshed at once only for the
   * player's own edits (`immediate`); otherwise it is marked dirty. Neighbouring sections are marked only when the block sits on
   * their border (face culling, ambient occlusion and smooth lighting read one block across).
   */
  onBlockChanged(x, y, z, immediate = false) {
    const cx = x >> 4, cz = z >> 4, sy = y >> 4;
    const lx = x & 15, ly = y & 15, lz = z & 15;
    // A player's own edit re-meshes its section and the sections sharing the block's faces at once (as before), so
    // a glass or ice block placed against its twin across a border never shows the inner face for a frame; the diagonal
    // neighbours (ambient occlusion at the corners) and every simulation change go through the dirty set.
    const now = immediate ? (ccx, ccz, ssy) => { if (!this.remeshSectionNow(ccx, ccz, ssy) || this.hybridInstant) this.markDirty(ccx, ccz, ssy); } : (ccx, ccz, ssy) => this.markDirty(ccx, ccz, ssy);
    const pr = immediate ? this.world.profiler : null;
    if (pr) pr.begin('syncRemesh');
    now(cx, cz, sy);
    const up = ly === 15 && sy < SECTION_COUNT - 1, down = ly === 0 && sy > 0;
    if (down) now(cx, cz, sy - 1);
    if (up) now(cx, cz, sy + 1);
    const ex = lx === 0 ? -1 : lx === 15 ? 1 : 0, ez = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    if (ex) { now(cx + ex, cz, sy); if (down) this.markDirty(cx + ex, cz, sy - 1); if (up) this.markDirty(cx + ex, cz, sy + 1); }
    if (ez) { now(cx, cz + ez, sy); if (down) this.markDirty(cx, cz + ez, sy - 1); if (up) this.markDirty(cx, cz + ez, sy + 1); }
    if (ex && ez) { this.markDirty(cx + ex, cz + ez, sy); if (down) this.markDirty(cx + ex, cz + ez, sy - 1); if (up) this.markDirty(cx + ex, cz + ez, sy + 1); } // AO at the corners
    if (pr) pr.end('syncRemesh');
  }

  /** Draw only the sections lo..hi of a chunk (the visibility walk's result); lo > hi hides it. */
  setVisibleRange(entry, lo, hi) {
    for (const name of PASS_NAMES) {
      const mesh = entry.meshes[name];
      if (!mesh) continue;
      if (lo > hi) { mesh.visible = false; continue; }
      const r = entry.ranges[name];
      const start = r[lo * R + 2], end = r[hi * R + 2] + r[hi * R + 3];
      if (end <= start) { mesh.visible = false; continue; }
      mesh.visible = true;
      const dr = mesh.geometry.drawRange;
      if (dr.start !== start || dr.count !== end - start) mesh.geometry.setDrawRange(start, end - start);
    }
  }

  /** Faces (quads) of one section in one pass (tests). */
  sectionFaceCount(cx, cz, sy, name) {
    const entry = this._entry(cx, cz, false);
    return entry ? entry.ranges[name][sy * R + 1] / 4 : 0;
  }

  /** The packed words of one section's pass (tests): [data (Uint32Array view), yf (Float32Array view | null), vertexCount]. */
  sectionVertices(cx, cz, sy, name) {
    const entry = this._entry(cx, cz, false);
    const buf = entry && entry.buffers[name];
    if (!buf) return [new Uint32Array(0), null, 0];
    const r = entry.ranges[name], vs = r[sy * R], vc = r[sy * R + 1];
    return [buf.data.array.subarray(vs * 2, (vs + vc) * 2), buf.yf ? buf.yf.array.subarray(vs, vs + vc) : null, vc];
  }

  /** Bytes held on the GPU by every chunk geometry (pass buffers at their allocated size) plus the shared index: the benchmark's geometry memory figure. */
  geometryBytes() {
    let bytes = this.sharedIndex ? this.sharedIndex.array.byteLength : 0;
    for (const entry of this.entries.values()) for (const name of PASS_NAMES) { const b = entry.buffers[name]; if (b) bytes += b.bytes; }
    return bytes;
  }

  /** Bytes of vertices actually in use (without the headroom and the shared index). */
  geometryUsedBytes() {
    let bytes = 0;
    for (const entry of this.entries.values()) for (const name of PASS_NAMES) { const b = entry.buffers[name]; if (b) bytes += b.used * (BYTES_PER_VERTEX + (b.yf ? 4 : 0)); }
    return bytes;
  }

  /** Triangles currently held in chunk geometry (all of them, drawn or culled). */
  triangleCount() {
    let tris = 0;
    for (const entry of this.entries.values()) for (const name of PASS_NAMES) { const b = entry.buffers[name]; if (b) tris += b.used / 2; }
    return tris;
  }

  /** Mark every loaded chunk for a full re-mesh (e.g. after toggling AO). */
  invalidateAll() {
    for (const chunk of this.world.chunks.values()) {
      chunk.meshed = false;
      chunk.revision++;
    }
  }
}
