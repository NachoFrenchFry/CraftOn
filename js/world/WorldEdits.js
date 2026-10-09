// WorldEdits.js — records player block changes per chunk as sparse diffs (localIndex → blockId),
// re-applied after procedural generation and persisted by SaveManager.

import { chunkKeyString } from './ChunkCoords.js';
import { BlockIds, REMOVED_BLOCK_IDS, REMOVED_TO_AIR_IDS } from '../blocks/BlockIds.js';

/** Blocks that were removed from the game become stone when an old save is loaded. */
const MIGRATE = new Map([...REMOVED_BLOCK_IDS.map((id) => [id, BlockIds.STONE]), ...REMOVED_TO_AIR_IDS.map((id) => [id, BlockIds.AIR])]); // hay bales (Update #11) become air

export class WorldEdits {
  constructor() {
    /** "cx,cz" → Map<localIndex, blockId> */
    this.chunks = new Map();
    /** Keys with unsaved changes. */
    this.dirtyKeys = new Set();
  }

  clear() {
    this.chunks.clear();
    this.dirtyKeys.clear();
  }

  record(cx, cz, localIndex, blockId) {
    const key = chunkKeyString(cx, cz);
    let map = this.chunks.get(key);
    if (!map) { map = new Map(); this.chunks.set(key, map); }
    map.set(localIndex, blockId);
    this.dirtyKeys.add(key);
  }

  /** Apply saved diffs for a chunk onto its block array. */
  applyTo(chunk) {
    const map = this.chunks.get(chunkKeyString(chunk.cx, chunk.cz));
    if (!map) return false;
    const blocks = chunk.blocks;
    for (const [index, id] of map) blocks[index] = id;
    return true;
  }

  hasEdits(cx, cz) { return this.chunks.has(chunkKeyString(cx, cz)); }

  /** Serialize one chunk's diffs into typed arrays for IndexedDB. */
  serializeChunk(key) {
    const map = this.chunks.get(key);
    if (!map) return null;
    const indices = new Uint16Array(map.size);
    const ids = new Uint8Array(map.size);
    let i = 0;
    for (const [index, id] of map) { indices[i] = index; ids[i] = id; i++; }
    return { indices, ids };
  }

  loadChunk(key, data) {
    const map = new Map();
    let migrated = false;
    for (let i = 0; i < data.indices.length; i++) {
      const id = data.ids[i];
      if (MIGRATE.has(id)) { map.set(data.indices[i], MIGRATE.get(id)); migrated = true; } else map.set(data.indices[i], id);
    }
    this.chunks.set(key, map);
    if (migrated) this.dirtyKeys.add(key); // save the converted blocks on the next autosave
  }

  /** Keys needing a save; cleared by the caller after persisting. */
  takeDirtyKeys() {
    const keys = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    return keys;
  }
}
