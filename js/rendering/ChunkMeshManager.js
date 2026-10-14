// ChunkMeshManager.js — owns the THREE meshes of the loaded chunks: uploads worker results, performs the
// synchronous re-mesh of a player's own edit, marks sections dirty for everything else and
// disposes geometry when chunks unload.
//
// one mesh per chunk per render pass (opaque, cutout, translucent, lava) instead of one per
// 16×16×16 section: a chunk's pass geometry is the concatenation of its sections' buffers, in section order, and
// the manager keeps every section's vertex / index range, so a single section edit rewrites one chunk pass
// (copying the untouched sections from the old buffers) and the visibility walk (Visibility.js) draws just the
// index span of the sections it reached. Every chunk mesh has a tight bounding box for frustum culling.

import * as THREE from 'three';
import { SECTION_COUNT, SECTION_SIZE, CHUNK_SIZE } from '../config/Constants.js';
import { chunkKey } from '../world/ChunkCoords.js';
import { buildPaddedChunk, allocPadded } from '../world/ChunkPadding.js';
import { meshSection, MeshBuilders, computeVisMask } from './ChunkMesher.js';
import { createChunkMaterials } from './Materials.js';

export const PASS_NAMES = ['opaque', 'cutout', 'translucent', 'lava'];
/** Per section and pass: [vertexStart, vertexCount, indexStart, indexCount]. */
const R = 4;

/** The render data of one loaded chunk. */
class ChunkEntry {
  constructor(cx, cz, chunk) {
    this.cx = cx; this.cz = cz;
    this.chunk = chunk;
    this.meshes = { opaque: null, cutout: null, translucent: null, lava: null };
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
    this.meshCount = 0;
    /** Chunk keys with `remeshMask` bits set since the last frame; ChunkManager drains it. */
    this.dirtyChunks = new Set();
    /** Culling statistics for F3 (Visibility.js writes them). */
    this.stats = { sections: 0, visible: 0, chunksVisible: 0 };
    this._replace = new Array(SECTION_COUNT).fill(undefined);
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

  _disposeMesh(entry, name) {
    const mesh = entry.meshes[name];
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    entry.meshes[name] = null;
    this.meshCount--;
  }

  /**
   * Rebuild one pass of a chunk: `replace[sy]` is a section's new pass data, null to drop that section, undefined to keep
   * what the old geometry holds. Untouched sections are copied from the old buffers (positions are chunk-local already).
   */
  _rebuildPass(entry, name, replace) {
    const old = entry.meshes[name];
    const og = old ? old.geometry : null;
    const r = entry.ranges[name];
    let verts = 0, idx = 0, lo = -1, hi = -1;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const d = replace[sy];
      const v = d === undefined ? r[sy * R + 1] : d ? d.vertexCount : 0;
      const i = d === undefined ? r[sy * R + 3] : d ? d.indices.length : 0;
      verts += v; idx += i;
      if (v) { if (lo < 0) lo = sy; hi = sy; }
    }
    if (!verts) {
      this._disposeMesh(entry, name);
      r.fill(0);
      return;
    }
    const positions = new Float32Array(verts * 3), uvs = new Float32Array(verts * 2), colors = new Uint8Array(verts * 3);
    const extra = new Uint8Array(verts), light = new Uint8Array(verts * 2), tiles = new Uint16Array(verts);
    const indices = verts < 65536 ? new Uint16Array(idx) : new Uint32Array(idx);
    const oa = og ? og.attributes : null;
    const oIdx = og ? og.index.array : null;
    let v = 0, i = 0;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const d = replace[sy];
      const vs = r[sy * R], vc = r[sy * R + 1], is = r[sy * R + 2], ic = r[sy * R + 3];
      r[sy * R] = v; r[sy * R + 2] = i;
      if (d === undefined && vc) {
        // keep: copy the section's slice of the old buffers, rebasing its indices
        positions.set(oa.position.array.subarray(vs * 3, (vs + vc) * 3), v * 3);
        uvs.set(oa.uv.array.subarray(vs * 2, (vs + vc) * 2), v * 2);
        colors.set(oa.color.array.subarray(vs * 3, (vs + vc) * 3), v * 3);
        extra.set(oa.extra.array.subarray(vs, vs + vc), v);
        light.set(oa.light.array.subarray(vs * 2, (vs + vc) * 2), v * 2);
        tiles.set(oa.tile.array.subarray(vs, vs + vc), v);
        const delta = v - vs;
        for (let k = 0; k < ic; k++) indices[i + k] = oIdx[is + k] + delta;
        r[sy * R + 1] = vc; r[sy * R + 3] = ic;
        v += vc; i += ic;
      } else if (d) {
        const n = d.vertexCount, yOff = sy * SECTION_SIZE;
        const p = d.positions;
        for (let k = 0; k < n; k++) { positions[(v + k) * 3] = p[k * 3]; positions[(v + k) * 3 + 1] = p[k * 3 + 1] + yOff; positions[(v + k) * 3 + 2] = p[k * 3 + 2]; }
        uvs.set(d.uvs, v * 2); colors.set(d.colors, v * 3); extra.set(d.extra, v); light.set(d.light, v * 2); tiles.set(d.tiles, v);
        const di = d.indices;
        for (let k = 0; k < di.length; k++) indices[i + k] = di[k] + v;
        r[sy * R + 1] = n; r[sy * R + 3] = di.length;
        v += n; i += di.length;
      } else { r[sy * R + 1] = 0; r[sy * R + 3] = 0; }
    }
    this._disposeMesh(entry, name);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geom.setAttribute('extra', new THREE.BufferAttribute(extra, 1)); // packed face / flags / AO byte (shader pipeline)
    geom.setAttribute('light', new THREE.BufferAttribute(light, 2)); // smoothed (sky, block) light ×16 (Updates #10 / #11)
    geom.setAttribute('tile', new THREE.BufferAttribute(tiles, 1)); // texture array layer
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    const y0 = lo * SECTION_SIZE, y1 = (hi + 1) * SECTION_SIZE;
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(0, y0, 0), new THREE.Vector3(CHUNK_SIZE, y1, CHUNK_SIZE));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, (y0 + y1) / 2, 8), Math.sqrt(128 + ((y1 - y0) / 2) ** 2));
    const mesh = new THREE.Mesh(geom, this.materials[name]);
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
    const bySy = new Array(SECTION_COUNT).fill(null);
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
    for (const name of PASS_NAMES) this._disposeMesh(entry, name);
    this.entries.delete(key);
  }

  removeAll() {
    for (const entry of this.entries.values()) for (const name of PASS_NAMES) this._disposeMesh(entry, name);
    this.entries.clear();
  }

  /** Synchronously re-mesh one section on the main thread (a player's own edit). Returns false when the chunk has no mesh yet. */
  remeshSectionNow(cx, cz, sy) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk || !chunk.meshed) return false;
    buildPaddedChunk(this.world, cx, cz, this.scratchPadded);
    this.builders.reset();
    if (chunk.sectionCounts[sy] > 0) meshSection(this.scratchPadded, sy, this.useAO, this.builders, this.fastLeaves, chunk.lit ? chunk.light : null);
    chunk.visMask[sy] = computeVisMask(this.scratchPadded, sy);
    this.applySection(cx, cz, sy, this.builders.results());
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
    const now = immediate ? (ccx, ccz, ssy) => { if (!this.remeshSectionNow(ccx, ccz, ssy)) this.markDirty(ccx, ccz, ssy); } : (ccx, ccz, ssy) => this.markDirty(ccx, ccz, ssy);
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

  /** Bytes held by every chunk geometry (attributes + indices): the benchmark's geometry memory figure. */
  geometryBytes() {
    let bytes = 0;
    for (const entry of this.entries.values()) {
      for (const name of PASS_NAMES) {
        const m = entry.meshes[name];
        if (!m) continue;
        const g = m.geometry;
        for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
        if (g.index) bytes += g.index.array.byteLength;
      }
    }
    return bytes;
  }

  /** Triangles currently held in chunk geometry (all of them, drawn or culled). */
  triangleCount() {
    let tris = 0;
    for (const entry of this.entries.values()) for (const name of PASS_NAMES) { const m = entry.meshes[name]; if (m) tris += m.geometry.index.count / 3; }
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
