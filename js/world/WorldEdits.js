// WorldEdits.js — records player block changes per chunk as sparse diffs (localIndex → blockId),
// re-applied after procedural generation and persisted by SaveManager. Containers (chest contents) live beside them,
// keyed by the same local index, so they save, load and travel with the chunk; old saves without them still load.

import { chunkKeyString } from './ChunkCoords.js';
import { BlockIds, REMOVED_BLOCK_IDS, REMOVED_TO_AIR_IDS } from '../blocks/BlockIds.js';

/** Blocks that were removed from the game become stone when an old save is loaded. */
const MIGRATE = new Map([...REMOVED_BLOCK_IDS.map((id) => [id, BlockIds.STONE]), ...REMOVED_TO_AIR_IDS.map((id) => [id, BlockIds.AIR])]); // hay bales become air

export class WorldEdits {
  constructor() {
    /** "cx,cz" → Map<localIndex, blockId> */
    this.chunks = new Map();
    /** Keys with unsaved changes. */
    this.dirtyKeys = new Set();
    /** "cx,cz" → Map<localIndex, serialized chest slots ([[id, n] | 0, …])> */
    this.containers = new Map();
    /** Chunks whose structure chests already received their generated loot (saved with the chunk, so emptied chests stay empty). */
    this.generated = new Set();
  }

  clear() {
    this.chunks.clear();
    this.dirtyKeys.clear();
    this.containers.clear();
    this.generated.clear();
  }

  /**
   * A freshly generated chunk's structure chests: their loot goes into the containers once — the first time this world
   * generates the chunk. Later generations (the chunk unloaded and came back, the world reloaded) see the flag and leave
   * the player's chest contents (or the emptied chest) alone. Returns true when the loot was written.
   */
  applyGenerated(cx, cz, containers) {
    const key = chunkKeyString(cx, cz);
    if (this.generated.has(key)) return false;
    this.generated.add(key);
    for (const c of containers) if (!this.getContainer(cx, cz, c.index)) this.setContainer(cx, cz, c.index, c.slots);
    this.dirtyKeys.add(key);
    return true;
  }

  /** Store (or with null, remove) a container's contents at a block of a chunk. */
  setContainer(cx, cz, localIndex, slots) {
    const key = chunkKeyString(cx, cz);
    let map = this.containers.get(key);
    if (slots) { if (!map) { map = new Map(); this.containers.set(key, map); } map.set(localIndex, slots); }
    else if (map) { map.delete(localIndex); if (!map.size) this.containers.delete(key); }
    else return;
    this.dirtyKeys.add(key);
  }

  getContainer(cx, cz, localIndex) {
    const map = this.containers.get(chunkKeyString(cx, cz));
    return map ? map.get(localIndex) || null : null;
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

  /** Every chunk key with anything to save: block edits, chest contents or the generated-loot flag. */
  allKeys() { return [...new Set([...this.chunks.keys(), ...this.containers.keys(), ...this.generated])]; }

  /** Serialize one chunk's diffs into typed arrays (plus its containers and the generated-loot flag) for the save and the network. */
  serializeChunk(key) {
    const map = this.chunks.get(key);
    const containers = this.containers.get(key);
    const generated = this.generated.has(key);
    if (!map && !containers && !generated) return null;
    const n = map ? map.size : 0;
    const indices = new Uint16Array(n);
    const ids = new Uint8Array(n);
    let i = 0;
    if (map) for (const [index, id] of map) { indices[i] = index; ids[i] = id; i++; }
    const out = { indices, ids };
    if (containers && containers.size) out.containers = [...containers].map(([index, slots]) => [index, slots]);
    if (generated) out.generated = true;
    return out;
  }

  loadChunk(key, data) {
    const map = new Map();
    let migrated = false;
    for (let i = 0; i < data.indices.length; i++) {
      const id = data.ids[i];
      if (MIGRATE.has(id)) { map.set(data.indices[i], MIGRATE.get(id)); migrated = true; } else map.set(data.indices[i], id);
    }
    this.chunks.set(key, map);
    if (Array.isArray(data.containers) && data.containers.length) this.containers.set(key, new Map(data.containers.filter((c) => Array.isArray(c) && c.length === 2).map(([index, slots]) => [index | 0, slots])));
    else this.containers.delete(key);
    if (data.generated) this.generated.add(key); else this.generated.delete(key);
    if (migrated) this.dirtyKeys.add(key); // save the converted blocks on the next autosave
  }

  /** Keys needing a save; cleared by the caller after persisting. */
  takeDirtyKeys() {
    const keys = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    return keys;
  }
}
