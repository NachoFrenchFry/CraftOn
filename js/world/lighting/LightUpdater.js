// LightUpdater.js — incremental lighting on the main thread (Update #10): a block placed or broken (by the player,
// flowing water, a multiplayer change) runs the two-phase remove + re-propagate BFS of LightEngine.js over the
// loaded, lit chunks inside a per-frame time budget (about 2 ms; the queues carry over, so huge changes never
// freeze the game). Every light change marks the section it lives in (and the neighbouring sections that read
// the cell for smooth lighting) in `chunk.lightDirty`, which ChunkManager turns into partial remeshes. The
// chunk light arrays use the padded layout, so a border cell exists twice (own chunk + neighbour's border): both
// copies are written. Pure JS, no DOM / Three.js.
import { SKY, LIGHT_MAX, OPACITY_BARRIER, lightIndex } from './LightStorage.js';
import { LightQueue, propagate, removeLight } from './LightEngine.js';
import { seamPass, SEAM_SIDES } from './LightSeams.js';
import { LIGHT_OPACITY } from '../../blocks/BlockRegistry.js';
import { blockIndex, chunkKey } from '../ChunkCoords.js';
import { WORLD_HEIGHT } from '../../config/Constants.js';

export const LIGHT_BUDGET_MS = 2;
/** Work done at once inside setBlock (so the edited section's instant remesh has fresh light); flowing water makes many edits per tick. */
const IMMEDIATE_MS = 0.3;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class LightUpdater {
  /** @param {import('../World.js').World} world */
  constructor(world) {
    this.world = world;
    this.removal = new LightQueue(4096);
    this.propagation = new LightQueue(4096);
    /** Chunk keys whose `lightDirty` mask is non-zero (consumed by ChunkManager). */
    this.dirtyChunks = new Set();
    this.timing = { total: 0, count: 0 };
    const self = this;
    /** LightEngine access over the loaded world (unlit chunks are barriers). */
    this.access = {
      opacity(x, y, z) {
        if (y >= WORLD_HEIGHT) return 0;
        if (y < 0) return OPACITY_BARRIER;
        const c = self.world.getChunk(x >> 4, z >> 4);
        if (!c || !c.lit) return OPACITY_BARRIER;
        return LIGHT_OPACITY[c.blocks[blockIndex(x & 15, y, z & 15)]];
      },
      get(x, y, z, channel) {
        if (y >= WORLD_HEIGHT) return channel === SKY ? LIGHT_MAX : 0;
        if (y < 0) return 0;
        const c = self.world.getChunk(x >> 4, z >> 4);
        if (!c || !c.lit) return 0;
        const b = c.light[lightIndex(x & 15, y, z & 15)];
        return channel === SKY ? b & 15 : b >> 4;
      },
      set(x, y, z, channel, v) { self._set(x, y, z, channel, v); },
    };
  }

  get pending() { return this.removal.length + this.propagation.length; }

  clear() { this.removal.clear(); this.propagation.clear(); this.dirtyChunks.clear(); }

  /** Write a cell into its chunk and into the border copies of up to three neighbours; mark the sections that read it. */
  _set(x, y, z, channel, v) {
    const cx = x >> 4, cz = z >> 4, lx = x & 15, lz = z & 15;
    const w = this.world;
    const write = (c, px, pz) => {
      if (!c || !c.lit) return;
      const i = lightIndex(px, y, pz);
      c.light[i] = channel === SKY ? (c.light[i] & 0xf0) | v : (c.light[i] & 0x0f) | (v << 4);
      this._markDirty(c, y, px, pz);
    };
    write(w.getChunk(cx, cz), lx, lz);
    if (lx === 0) write(w.getChunk(cx - 1, cz), 16, lz);
    if (lx === 15) write(w.getChunk(cx + 1, cz), -1, lz);
    if (lz === 0) write(w.getChunk(cx, cz - 1), lx, 16);
    if (lz === 15) write(w.getChunk(cx, cz + 1), lx, -1);
    if (lx === 0 && lz === 0) write(w.getChunk(cx - 1, cz - 1), 16, 16);
    if (lx === 15 && lz === 0) write(w.getChunk(cx + 1, cz - 1), -1, 16);
    if (lx === 0 && lz === 15) write(w.getChunk(cx - 1, cz + 1), 16, -1);
    if (lx === 15 && lz === 15) write(w.getChunk(cx + 1, cz + 1), -1, -1);
  }

  /** The section containing the cell plus the vertically adjacent one when the cell sits on a section border (smooth lighting reads one cell out). */
  _markDirty(chunk, y, px, pz) {
    void px; void pz; // a border copy is read by this chunk's edge faces: the same sections apply
    const sy = y >> 4;
    let mask = 1 << sy;
    if ((y & 15) === 0 && sy > 0) mask |= 1 << (sy - 1);
    if ((y & 15) === 15 && sy < 15) mask |= 1 << (sy + 1);
    if ((chunk.lightDirty & mask) !== mask) { chunk.lightDirty |= mask; this.dirtyChunks.add(chunkKey(chunk.cx, chunk.cz)); }
  }

  /**
   * A block changed at (x, y, z): darken what the old light reached, then re-light from the neighbours (and
   * the sky column above, through the engine's straight-down rule). Runs one budget slice at once so the
   * synchronous remesh of the edited section already sees the new light; the rest continues in update().
   */
  onBlockChanged(x, y, z) {
    const c = this.world.getChunk(x >> 4, z >> 4);
    if (!c || !c.lit) return;
    const t0 = now();
    const old = this.access.get(x, y, z, SKY);
    if (old > 0) { this._set(x, y, z, SKY, 0); this.removal.push(x, y, z, old); }
    // Seed from the 6 neighbours (a broken block in a lit area, or the cell above with sky light).
    this.propagation.push(x + 1, y, z, 0); this.propagation.push(x - 1, y, z, 0);
    this.propagation.push(x, y + 1, z, 0); this.propagation.push(x, y - 1, z, 0);
    this.propagation.push(x, y, z + 1, 0); this.propagation.push(x, y, z - 1, 0);
    this.update(IMMEDIATE_MS);
    this.timing.total += now() - t0; this.timing.count++;
  }

  /** A chunk's initial light arrived: seams with lit neighbours catch edits made while the job was in flight. */
  onChunkLit(chunk) {
    for (const [side, dx, dz] of SEAM_SIDES) {
      const n = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (n && n.lit) seamPass(this.access, SKY, chunk.cx, chunk.cz, side, this.propagation);
    }
  }

  /** Per frame: removal first, then propagation, within the budget. Returns true when the queues are empty. */
  update(budgetMs = LIGHT_BUDGET_MS) {
    if (this.removal.empty && this.propagation.empty) return true;
    const deadline = now() + budgetMs;
    if (!removeLight(this.access, SKY, this.removal, this.propagation, deadline)) return false;
    return propagate(this.access, SKY, this.propagation, deadline);
  }

  /** Run everything that is queued (tests / world load). */
  flush() { while (!this.update(1e9)) { /* until empty */ } }
}
