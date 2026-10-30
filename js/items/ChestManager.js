// ChestManager.js — the chests of the loaded world: one ChestStorage per chest block, its contents kept inside the
// chunk's edit data (WorldEdits containers, so they save and load with the chunk and travel with the chunk rows on a
// server). Breaking a chest (by hand, by an explosion, by any replacement) drops its contents. On a server the host
// owns every chest: its changes are broadcast per slot; guests only mirror (their own clicks go through the host).

import { ChestStorage } from './ChestStorage.js';
import { ItemStack } from './ItemStack.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { blockIndex } from '../world/ChunkCoords.js';

export class ChestManager {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** "x,y,z" → ChestStorage of the chests touched since the world loaded. */
    this.open_ = new Map();
    /** Host hook: (x, y, z, slot, storage) after a change (slot −1 = all). */
    this.onSlotChanged = null;
    /** True while applying a remote (host) update: the local write-back happens, no broadcast. */
    this.applyingRemote = false;
    this.events = game.events;
  }

  static key(x, y, z) { return `${x},${y},${z}`; }

  get edits() { return this.game.world.edits; }

  /** The storage of the chest at (x, y, z), loaded from the chunk data (or empty). */
  open(x, y, z) {
    const key = ChestManager.key(x, y, z);
    let st = this.open_.get(key);
    if (st) return st;
    const data = this.edits.getContainer(x >> 4, z >> 4, blockIndex(x & 15, y, z & 15));
    st = new ChestStorage(key, data, (storage, slot) => this._changed(x, y, z, storage, slot));
    this.open_.set(key, st);
    return st;
  }

  /** The storage if it was opened already (no load). */
  peek(x, y, z) { return this.open_.get(ChestManager.key(x, y, z)) || null; }

  _changed(x, y, z, storage, slot) {
    this.edits.setContainer(x >> 4, z >> 4, blockIndex(x & 15, y, z & 15), storage.isEmpty() ? null : storage.serialize());
    this.events.emit('chest:changed', x, y, z, slot, storage);
    if (this.onSlotChanged && !this.applyingRemote) this.onSlotChanged(x, y, z, slot, storage);
  }

  /** A host update for one slot (guests) — written locally, never re-broadcast. */
  applyRemoteSlot(x, y, z, slot, stackData) {
    const st = this.open(x, y, z);
    this.applyingRemote = true;
    try { st.set(slot, stackData ? ItemStack.deserialize(stackData) : null); } finally { this.applyingRemote = false; }
  }

  /** The host's full contents (a guest opening a chest). */
  applyRemoteContents(x, y, z, data) {
    const st = this.open(x, y, z);
    this.applyingRemote = true;
    try { st.load(data); } finally { this.applyingRemote = false; }
  }

  /**
   * A block changed: a chest that disappears (or is replaced) drops its contents (the host or single player; guests get
   * the drops from the host) and loses its container; a chest placed over a stale container starts empty.
   */
  onBlockChanged(x, y, z, oldId, newId) {
    const wasChest = BlockRegistry.isContainer(oldId), isChest = BlockRegistry.isContainer(newId);
    if (!wasChest && !isChest) return;
    if (wasChest && !isChest) {
      const st = this.open(x, y, z);
      if (!this.game.isGuest) {
        for (const s of st.slots) if (s) this.game.entities.spawnItem(x + 0.5, y + 0.3, z + 0.5, s.itemId, s.count);
      }
      this.applyingRemote = true; // the slot wipes below need no broadcast: the block itself is gone for everyone
      try { st.slots.fill(null); st.changed(-1); } finally { this.applyingRemote = false; }
      this.open_.delete(ChestManager.key(x, y, z));
      this.edits.setContainer(x >> 4, z >> 4, blockIndex(x & 15, y, z & 15), null);
      if (this.game.ui && this.game.ui.inventory && this.game.ui.inventory.chestPos && this.game.ui.inventory.chestPos.x === x && this.game.ui.inventory.chestPos.y === y && this.game.ui.inventory.chestPos.z === z) this.game.closeInventory(true);
    } else if (!wasChest && isChest) {
      this.open_.delete(ChestManager.key(x, y, z));
      this.edits.setContainer(x >> 4, z >> 4, blockIndex(x & 15, y, z & 15), null);
    }
  }

  /** Leaving a world. */
  clear() { this.open_.clear(); }
}
