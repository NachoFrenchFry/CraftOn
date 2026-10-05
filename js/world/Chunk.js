// Chunk.js — block storage for one 16×256×16 column: a Uint8Array plus per-section bookkeeping.

import { BLOCKS_PER_CHUNK, SECTION_COUNT, WORLD_HEIGHT } from '../config/Constants.js';
import { blockIndex } from './ChunkCoords.js';

export const ChunkState = Object.freeze({ PENDING: 0, GENERATED: 1 });

export class Chunk {
  constructor(cx, cz, blocks = null) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = blocks || new Uint8Array(BLOCKS_PER_CHUNK);
    /** Terrain surface height per column (from the generator). */
    this.heightMap = new Uint8Array(256);
    this.biomeMap = new Uint8Array(256);
    /** Cave springs placed by the generator: flat [lx, y, lz, ...] (scheduled for water updates on load). */
    this.springs = null;
    this.state = ChunkState.PENDING;
    /** Non-air block count per 16-block section (empty sections are skipped by the mesher). */
    this.sectionCounts = new Uint16Array(SECTION_COUNT);
    /** Bitmask of sections whose mesh is stale. */
    this.dirtySections = 0;
    /** Incremented on every edit so stale worker results can be discarded. */
    this.version = 0;
    /** True once a mesh has been built for the current version. */
    this.meshed = false;
    this.meshing = false;
    this.meshRequested = false;
  }

  get(lx, ly, lz) {
    if (ly < 0 || ly >= WORLD_HEIGHT) return 0;
    return this.blocks[blockIndex(lx, ly, lz)];
  }

  /** Set a block; returns the previous id. Keeps section counts and dirty flags in sync. */
  set(lx, ly, lz, id) {
    if (ly < 0 || ly >= WORLD_HEIGHT) return 0;
    const i = blockIndex(lx, ly, lz);
    const old = this.blocks[i];
    if (old === id) return old;
    this.blocks[i] = id;
    const sy = ly >> 4;
    if (old === 0) this.sectionCounts[sy]++;
    if (id === 0) this.sectionCounts[sy]--;
    this.dirtySections |= 1 << sy;
    this.version++;
    return old;
  }

  /** Recompute section non-air counts after bulk writes (generation, edits). */
  recountSections() {
    const counts = this.sectionCounts;
    counts.fill(0);
    const b = this.blocks;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      let n = 0;
      const start = sy * 4096, end = start + 4096;
      for (let i = start; i < end; i++) if (b[i] !== 0) n++;
      counts[sy] = n;
    }
  }

  /** Bitmask of non-empty sections. */
  nonEmptyMask() {
    let m = 0;
    for (let sy = 0; sy < SECTION_COUNT; sy++) if (this.sectionCounts[sy] > 0) m |= 1 << sy;
    return m;
  }

  /** Highest non-air block in a column, or -1. */
  topBlockY(lx, lz) {
    const b = this.blocks;
    const base = lx + (lz << 4);
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) if (b[base + (y << 8)] !== 0) return y;
    return -1;
  }
}
