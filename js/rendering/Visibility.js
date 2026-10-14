// Visibility.js — cave culling, Minecraft's visibility graph: every meshed section knows which pairs
// of its six faces connect through non-opaque blocks (ChunkMesher.computeVisMask, stored on the chunk). Each frame a
// breadth-first walk starts at the camera's section and crosses only connected faces, never back towards the camera
// and never outside the view frustum or the render-distance circle. Sections the walk does not reach are not drawn:
// on the surface that hides the caves below, underground it hides the surface above. The result is applied as a
// per-chunk range of sections (ChunkMeshManager.setVisibleRange: one index span per chunk pass).

import * as THREE from 'three';
import { SECTION_COUNT, SECTION_SIZE, CHUNK_SIZE } from '../config/Constants.js';
import { chunkKey } from '../world/ChunkCoords.js';
import { visConnected } from './ChunkMesher.js';
import { OPAQUE } from '../blocks/BlockRegistry.js';
import { blockIndex } from '../world/ChunkCoords.js';

const OPPOSITE = [1, 0, 3, 2, 5, 4];
const NX = [1, -1, 0, 0, 0, 0], NY = [0, 0, 1, -1, 0, 0], NZ = [0, 0, 0, 0, 1, -1];
const SECTION_RADIUS = Math.sqrt(3) * SECTION_SIZE * 0.5 + 0.5;
const MAX_NODES = 65536;

export class ChunkVisibility {
  /** @param {import('./ChunkMeshManager.js').ChunkMeshManager} meshManager */
  constructor(meshManager) {
    this.meshManager = meshManager;
    this.enabled = true;
    this.frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();
    this.stamp = 0;
    this._qEntry = new Array(MAX_NODES).fill(null);
    this._qSy = new Uint8Array(MAX_NODES);
    this._qTravel = new Uint8Array(MAX_NODES);
    this._qFrom = new Int8Array(MAX_NODES);
    this.lastVisited = 0;
    this.lastMs = 0;
    /** The camera's own air pocket inside its section: which faces it touches (cached per cell and chunk version). */
    this._pocketKey = '';
    this._pocketFaces = 0x3f;
    this._seen = new Uint8Array(4096);
    this._stack = new Int16Array(4096);
  }

  /**
   * Faces of the camera's section reachable from the camera's cell through non-opaque blocks: a player in a
   * sealed room sees nothing of the caves around it, even when another pocket of the same section opens to the outside. All
   * six faces when the camera sits inside a solid block (noclip, the third-person camera in a wall).
   */
  _startFaces(chunk, sy, lx, ly, lz) {
    const key = `${chunk.cx},${chunk.cz},${sy},${lx},${ly},${lz},${chunk.revision}`;
    if (key === this._pocketKey) return this._pocketFaces;
    this._pocketKey = key;
    const blocks = chunk.blocks, y0 = sy * SECTION_SIZE;
    const seen = this._seen, stack = this._stack;
    const start = lx + (lz << 4) + (ly << 8);
    if (OPAQUE[blocks[blockIndex(lx, y0 + ly, lz)]] === 1) { this._pocketFaces = 0x3f; return 0x3f; }
    seen.fill(0);
    let top = 0, faces = 0;
    stack[top++] = start; seen[start] = 1;
    while (top > 0) {
      const c = stack[--top];
      const x = c & 15, z = (c >> 4) & 15, y = c >> 8;
      if (x === 0) faces |= 2; if (x === 15) faces |= 1;      // west, east
      if (y === 0) faces |= 8; if (y === 15) faces |= 4;      // down, up
      if (z === 0) faces |= 32; if (z === 15) faces |= 16;    // north, south
      for (let d = 0; d < 6; d++) {
        const nx = x + NX[d], ny = y + NY[d], nz = z + NZ[d];
        if (nx < 0 || nx > 15 || ny < 0 || ny > 15 || nz < 0 || nz > 15) continue;
        const n = nx + (nz << 4) + (ny << 8);
        if (seen[n]) continue;
        seen[n] = 1;
        if (OPAQUE[blocks[blockIndex(nx, y0 + ny, nz)]] === 1) continue;
        stack[top++] = n;
      }
    }
    this._pocketFaces = faces;
    return faces;
  }

  /** Show every chunk fully (culling off, or no start section). */
  showAll() {
    const mm = this.meshManager;
    for (const e of mm.entries.values()) mm.setVisibleRange(e, 0, SECTION_COUNT - 1);
  }

  /**
   * Walk from the camera and apply the result. `pcx`/`pcz` and `rd` describe the render-distance circle (chunk units).
   * @param {THREE.Camera} camera
   */
  update(camera, pcx, pcz, rd) {
    const t0 = performance.now();
    const mm = this.meshManager;
    if (!this.enabled) { this.showAll(); this.lastMs = performance.now() - t0; return; }
    this.stamp++;
    const stamp = this.stamp;
    camera.updateMatrixWorld();
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    const cam = camera.position;
    const scx = Math.floor(cam.x) >> 4, scz = Math.floor(cam.z) >> 4;
    let ssy = Math.floor(cam.y) >> 4;
    if (ssy < 0) ssy = 0; else if (ssy >= SECTION_COUNT) ssy = SECTION_COUNT - 1;
    const start = mm.entries.get(chunkKey(scx, scz));
    if (!start || !start.chunk) { this.showAll(); this.lastMs = performance.now() - t0; return; }
    const cy = Math.floor(cam.y);
    const startFaces = cy >= 0 && cy < SECTION_COUNT * SECTION_SIZE ? this._startFaces(start.chunk, ssy, Math.floor(cam.x) & 15, cy & 15, Math.floor(cam.z) & 15) : 0x3f;
    const qEntry = this._qEntry, qSy = this._qSy, qTravel = this._qTravel, qFrom = this._qFrom, sphere = this._sphere, frustum = this.frustum;
    const rd2 = rd * rd;
    let head = 0, tail = 0;
    qEntry[tail] = start; qSy[tail] = ssy; qTravel[tail] = 0; qFrom[tail] = -1; tail++;
    start.visStamp[ssy] = stamp;
    let visited = 0;
    while (head < tail) {
      const e = qEntry[head], sy = qSy[head], trav = qTravel[head], from = qFrom[head];
      qEntry[head] = null;
      head++;
      visited++;
      if (e.visFrame !== stamp) { e.visFrame = stamp; e.visLo = sy; e.visHi = sy; }
      else { if (sy < e.visLo) e.visLo = sy; if (sy > e.visHi) e.visHi = sy; }
      const mask = e.chunk.visMask[sy];
      for (let d = 0; d < 6; d++) {
        if (trav & (1 << OPPOSITE[d])) continue;               // never back towards the camera
        if (from >= 0 ? !visConnected(mask, from, d) : !(startFaces & (1 << d))) continue; // the section must connect its entry face (or the camera's pocket) to this exit
        const nsy = sy + NY[d];
        if (nsy < 0 || nsy >= SECTION_COUNT) continue;
        let ne = e;
        if (NX[d] !== 0 || NZ[d] !== 0) {
          const ncx = e.cx + NX[d], ncz = e.cz + NZ[d];
          const ddx = ncx - pcx, ddz = ncz - pcz;
          if (ddx * ddx + ddz * ddz > rd2) continue;             // beyond the render-distance circle
          ne = mm.entries.get(chunkKey(ncx, ncz));
          if (!ne || !ne.chunk) continue;
        }
        if (ne.visStamp[nsy] === stamp) continue;
        sphere.center.set(ne.cx * CHUNK_SIZE + 8, nsy * SECTION_SIZE + 8, ne.cz * CHUNK_SIZE + 8);
        sphere.radius = SECTION_RADIUS;
        if (!frustum.intersectsSphere(sphere)) continue;
        ne.visStamp[nsy] = stamp;
        if (tail >= MAX_NODES) continue;
        qEntry[tail] = ne; qSy[tail] = nsy; qTravel[tail] = trav | (1 << d); qFrom[tail] = OPPOSITE[d]; tail++;
      }
    }
    let chunksVisible = 0, sections = 0, visibleSections = 0;
    for (const e of mm.entries.values()) {
      sections += SECTION_COUNT;
      if (e.visFrame === stamp) { chunksVisible++; visibleSections += e.visHi - e.visLo + 1; mm.setVisibleRange(e, e.visLo, e.visHi); }
      else mm.setVisibleRange(e, 1, 0);
    }
    this.lastVisited = visited;
    mm.stats.sections = sections; mm.stats.visible = visibleSections; mm.stats.chunksVisible = chunksVisible;
    this.lastMs = performance.now() - t0;
  }
}
