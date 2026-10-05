// ChunkMeshManager.js — owns the THREE meshes per chunk section: uploads worker results, performs
// synchronous re-meshes for block edits, and disposes geometry when chunks unload.

import * as THREE from 'three';
import { SECTION_COUNT, SECTION_SIZE, CHUNK_SIZE } from '../config/Constants.js';
import { chunkKey } from '../world/ChunkCoords.js';
import { buildPaddedChunk, allocPadded } from '../world/ChunkPadding.js';
import { meshSection, MeshBuilders } from './ChunkMesher.js';
import { createChunkMaterials } from './Materials.js';

const SECTION_RADIUS = Math.sqrt(3) * SECTION_SIZE * 0.5 + 0.5;
const PASS_NAMES = ['opaque', 'cutout', 'translucent'];

export class ChunkMeshManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/World.js').World} world
   * @param {THREE.Texture} atlasTexture
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(scene, world, atlasTexture, settings) {
    this.scene = scene;
    this.world = world;
    this.settings = settings;
    this.materials = createChunkMaterials(atlasTexture);
    /** packed key → Array(16) of { opaque, cutout, translucent } meshes or null */
    this.chunkMeshes = new Map();
    this.scratchPadded = allocPadded();
    this.builders = new MeshBuilders();
    this.meshCount = 0;
    world.meshManager = this;
  }

  get useAO() { return this.settings.get('smoothLighting'); }

  _entry(cx, cz, create) {
    const key = chunkKey(cx, cz);
    let entry = this.chunkMeshes.get(key);
    if (!entry && create) {
      entry = new Array(SECTION_COUNT).fill(null);
      this.chunkMeshes.set(key, entry);
    }
    return entry || null;
  }

  _disposeSection(entry, sy) {
    const sec = entry[sy];
    if (!sec) return;
    for (const name of PASS_NAMES) {
      const mesh = sec[name];
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.meshCount--;
    }
    entry[sy] = null;
  }

  _makeMesh(cx, sy, cz, data, material) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geom.setAttribute('color', new THREE.BufferAttribute(data.colors, 3, true));
    geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), SECTION_RADIUS);
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(16, 16, 16));
    const mesh = new THREE.Mesh(geom, material);
    mesh.position.set(cx * CHUNK_SIZE, sy * SECTION_SIZE, cz * CHUNK_SIZE);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    mesh.name = 'section';
    this.scene.add(mesh);
    this.meshCount++;
    return mesh;
  }

  /** Replace the meshes of one section with new pass buffers (any pass may be null). */
  applySection(cx, cz, sy, passes) {
    const entry = this._entry(cx, cz, true);
    this._disposeSection(entry, sy);
    const sec = { opaque: null, cutout: null, translucent: null };
    let any = false;
    for (const name of PASS_NAMES) {
      const data = passes[name];
      if (!data) continue;
      sec[name] = this._makeMesh(cx, sy, cz, data, this.materials[name]);
      any = true;
    }
    if (any) entry[sy] = sec;
  }

  /** Apply a full worker result ({ sections: [{sy, opaque, cutout, translucent}] }). */
  applyChunkResult(cx, cz, result, sectionMask) {
    const entry = this._entry(cx, cz, true);
    // Sections that were meshed as empty must lose any stale meshes.
    for (let sy = 0; sy < SECTION_COUNT; sy++) if (sectionMask & (1 << sy)) this._disposeSection(entry, sy);
    for (const s of result.sections) this.applySection(cx, cz, s.sy, s);
  }

  /** Remove and dispose every mesh of a chunk. */
  removeChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const entry = this.chunkMeshes.get(key);
    if (!entry) return;
    for (let sy = 0; sy < SECTION_COUNT; sy++) this._disposeSection(entry, sy);
    this.chunkMeshes.delete(key);
  }

  removeAll() {
    for (const key of [...this.chunkMeshes.keys()]) {
      const entry = this.chunkMeshes.get(key);
      for (let sy = 0; sy < SECTION_COUNT; sy++) this._disposeSection(entry, sy);
    }
    this.chunkMeshes.clear();
  }

  /** Synchronously re-mesh one section on the main thread (used for instant edit feedback). */
  remeshSectionNow(cx, cz, sy) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk || !chunk.meshed) return;
    buildPaddedChunk(this.world, cx, cz, this.scratchPadded);
    this.builders.reset();
    if (chunk.sectionCounts[sy] > 0) meshSection(this.scratchPadded, sy, this.useAO, this.builders);
    this.applySection(cx, cz, sy, this.builders.results());
    chunk.dirtySections &= ~(1 << sy);
  }

  /**
   * A neighbouring chunk's padded copy now differs from what any in-flight worker job read: bump its version
   * so a stale result is discarded and the chunk is meshed again from fresh padding (otherwise the result
   * lands after the edit and shows e.g. the face between two ice blocks across the border). The synchronous
   * re-mesh below still gives instant feedback when the neighbour is already meshed.
   */
  _touchNeighbor(cx, cz, sy) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk) return;
    chunk.version++;
    chunk.dirtySections |= 1 << sy;
    this.remeshSectionNow(cx, cz, sy);
  }

  /** Called by World.setBlock for every block type: re-mesh the section plus the neighbours when on a border. */
  onBlockChanged(x, y, z) {
    const cx = x >> 4, cz = z >> 4, sy = y >> 4;
    const lx = x & 15, ly = y & 15, lz = z & 15;
    this.remeshSectionNow(cx, cz, sy);
    if (lx === 0) this._touchNeighbor(cx - 1, cz, sy);
    if (lx === 15) this._touchNeighbor(cx + 1, cz, sy);
    if (lz === 0) this._touchNeighbor(cx, cz - 1, sy);
    if (lz === 15) this._touchNeighbor(cx, cz + 1, sy);
    if (ly === 0 && sy > 0) this.remeshSectionNow(cx, cz, sy - 1);
    if (ly === 15 && sy < SECTION_COUNT - 1) this.remeshSectionNow(cx, cz, sy + 1);
    // Diagonal chunks matter for AO at the corners.
    if ((lx === 0 || lx === 15) && (lz === 0 || lz === 15)) {
      this._touchNeighbor(cx + (lx === 0 ? -1 : 1), cz + (lz === 0 ? -1 : 1), sy);
    }
  }

  /** Mark every loaded chunk for a full re-mesh (e.g. after toggling AO). */
  invalidateAll() {
    for (const chunk of this.world.chunks.values()) {
      chunk.meshed = false;
      chunk.meshRequested = false;
      chunk.version++;
    }
  }
}
