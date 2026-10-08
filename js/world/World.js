// World.js — public block API in world coordinates: getBlock/setBlock, chunk lookup, edits, remeshing.

import { WORLD_HEIGHT } from '../config/Constants.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { SOLID, OPAQUE, RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';
import { chunkKey, blockIndex } from './ChunkCoords.js';
import { WorldEdits } from './WorldEdits.js';
import { lightIndex } from './lighting/LightStorage.js';

export class World {
  constructor(events) {
    this.events = events;
    /** packed key → Chunk */
    this.chunks = new Map();
    this.edits = new WorldEdits();
    this.seed = 0;
    /** Set by ChunkMeshManager so edits can remesh instantly. */
    this.meshManager = null;
    /** Set by ChunkManager: incremental voxel lighting (Update #10). */
    this.lightUpdater = null;
  }

  clear() {
    this.chunks.clear();
    this.edits.clear();
  }

  getChunk(cx, cz) { return this.chunks.get(chunkKey(cx, cz)) || null; }
  hasChunk(cx, cz) { return this.chunks.has(chunkKey(cx, cz)); }
  addChunk(chunk) { this.chunks.set(chunkKey(chunk.cx, chunk.cz), chunk); }
  removeChunk(cx, cz) { return this.chunks.delete(chunkKey(cx, cz)); }

  /** True when the chunk containing (x, z) has block data. */
  isLoadedAt(x, z) {
    return this.chunks.has(chunkKey(Math.floor(x) >> 4, Math.floor(z) >> 4));
  }

  /** Block id at integer world coordinates (AIR when unloaded or out of range). */
  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return BlockIds.AIR;
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!chunk) return BlockIds.AIR;
    return chunk.blocks[blockIndex(x & 15, y, z & 15)];
  }

  /** Convenience for fractional positions. */
  getBlockAt(x, y, z) {
    return this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  isSolid(x, y, z) { return SOLID[this.getBlock(x, y, z)] === 1; }
  isOpaque(x, y, z) { return OPAQUE[this.getBlock(x, y, z)] === 1; }
  isLiquid(x, y, z) { return RENDER_TYPE[this.getBlock(x, y, z)] === RenderType.LIQUID; }

  /**
   * Set a block. Records the edit (for saving), remeshes affected sections immediately and emits
   * 'block:changed' (x, y, z, {old, id}).
   */
  setBlock(x, y, z, id, record = true) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = x >> 4, cz = z >> 4;
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return false;
    const lx = x & 15, lz = z & 15;
    const old = chunk.set(lx, y, lz, id);
    if (old === id) return false;
    if (record) this.edits.record(cx, cz, blockIndex(lx, y, lz), id);
    if (this.lightUpdater) this.lightUpdater.onBlockChanged(x, y, z); // light first, so the remesh below already sees it
    if (this.meshManager) this.meshManager.onBlockChanged(x, y, z);
    this.events.emit('block:changed', x, y, z, { old, id, recorded: record });
    return true;
  }

  /** Sky light 0–15 at integer world coordinates (15 above the world and in chunks that are not lit yet, so nothing goes black while loading). */
  getSkyLight(x, y, z) {
    if (y >= WORLD_HEIGHT) return 15;
    if (y < 0) return 0;
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!chunk || !chunk.lit) return 15;
    return chunk.light[lightIndex(x & 15, y, z & 15)] & 15;
  }

  getSkyLightAt(x, y, z) { return this.getSkyLight(Math.floor(x), Math.floor(y), Math.floor(z)); }

  /** Highest non-air block y in a column, or -1 when unloaded/empty. */
  getTopY(x, z) {
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!chunk) return -1;
    return chunk.topBlockY(x & 15, z & 15);
  }

  /** Biome id at a column (0 when unloaded). */
  getBiome(x, z) {
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!chunk) return 0;
    return chunk.biomeMap[(x & 15) + ((z & 15) << 4)];
  }
}
