// LightEngine.js — the generic BFS flood fill of the voxel lighting design (docs/LIGHTING.md), for both channels:
// propagation (a light source placed / a block broken) and the two-phase depropagation (a source removed / a block
// placed). Works on any `access` object { opacity(x,y,z), get(x,y,z,channel), set(x,y,z,channel,v) }: the worker's
// 3×3-chunk grid for initial lighting (SkyLight.js) and the loaded world for incremental updates (LightUpdater.js).
// Light spreads in 6 directions; each step costs 1 + the receiving cell's opacity; opaque cells (15) and
// unloaded cells (OPACITY_BARRIER) block it. Sky light keeps its level straight down (the "sky column" rule):
// a downward step from a cell whose upward neighbour is at least as bright costs only the opacity.
// Queues are flat Int32 ring buffers so a huge change never allocates per cell; `deadline` (performance.now()
// time) lets the caller spread the work across frames. Pure and worker-safe.
import { SKY, LIGHT_MAX, OPACITY_BARRIER } from './LightStorage.js';

/** Neighbour offsets: ±x, ±y, ±z. Index 3 is DOWN. */
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DOWN = 3;

/** FIFO of (x, y, z, value) quads. */
export class LightQueue {
  constructor(capacity = 4096) {
    this.buf = new Int32Array(capacity * 4);
    this.head = 0;
    this.tail = 0;
  }

  get length() { return (this.tail - this.head) / 4; }
  get empty() { return this.tail === this.head; }

  push(x, y, z, v) {
    if (this.tail + 4 > this.buf.length) {
      // Compact (drop the consumed prefix) or grow.
      const live = this.tail - this.head;
      if (this.head > 0 && live <= this.buf.length / 2) this.buf.copyWithin(0, this.head, this.tail);
      else { const next = new Int32Array(this.buf.length * 2); next.set(this.buf.subarray(this.head, this.tail)); this.buf = next; }
      this.tail = live; this.head = 0;
    }
    const b = this.buf, t = this.tail;
    b[t] = x; b[t + 1] = y; b[t + 2] = z; b[t + 3] = v;
    this.tail = t + 4;
  }

  /** Reads the next quad into `out` ([x, y, z, v]); false when empty. */
  shift(out) {
    if (this.head === this.tail) return false;
    const b = this.buf, h = this.head;
    out[0] = b[h]; out[1] = b[h + 1]; out[2] = b[h + 2]; out[3] = b[h + 3];
    this.head = h + 4;
    if (this.head === this.tail) { this.head = 0; this.tail = 0; }
    return true;
  }

  clear() { this.head = 0; this.tail = 0; }
}

const cell = [0, 0, 0, 0];
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Spread light from every queued cell until the queue is empty (returns true) or the deadline passes (false;
 * the queue keeps the rest). Queue entries are (x, y, z, _): the cell's current light is re-read, so stale
 * entries are harmless.
 */
export function propagate(access, channel, queue, deadline = Infinity) {
  let n = 0;
  while (queue.shift(cell)) {
    const x = cell[0], y = cell[1], z = cell[2];
    const cur = access.get(x, y, z, channel);
    if (cur <= 0) continue;
    const columnLit = channel === SKY && access.get(x, y + 1, z, channel) >= cur;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1], nz = z + DIRS[d][2];
      const op = access.opacity(nx, ny, nz);
      if (op >= LIGHT_MAX) continue; // opaque, unloaded or outside the world
      const nl = (d === DOWN && columnLit) ? cur - op : cur - 1 - op;
      if (nl <= 0) continue;
      if (nl > access.get(nx, ny, nz, channel)) { access.set(nx, ny, nz, channel, nl); queue.push(nx, ny, nz, nl); }
    }
    if ((++n & 63) === 0 && deadline !== Infinity && now() > deadline) return false;
  }
  return true;
}

/**
 * Phase 1 of depropagation: every queued (x, y, z, oldLevel) cell has already been set to 0. Neighbours whose
 * light could only have come from it are zeroed and queued in turn; neighbours lit by something else go to
 * `propagation` so phase 2 (propagate) re-fills the darkened area. Returns true when done.
 */
export function removeLight(access, channel, removal, propagation, deadline = Infinity) {
  let n = 0;
  while (removal.shift(cell)) {
    const x = cell[0], y = cell[1], z = cell[2], old = cell[3];
    for (let d = 0; d < 6; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1], nz = z + DIRS[d][2];
      const nl = access.get(nx, ny, nz, channel);
      if (nl <= 0) continue;
      const op = access.opacity(nx, ny, nz);
      if (op >= LIGHT_MAX) continue;
      const given = (d === DOWN && channel === SKY) ? old - op : old - 1 - op; // what the removed light gave this cell
      if (nl <= given) { access.set(nx, ny, nz, channel, 0); removal.push(nx, ny, nz, nl); }
      else propagation.push(nx, ny, nz, nl);
    }
    if ((++n & 63) === 0 && deadline !== Infinity && now() > deadline) return false;
  }
  return true;
}

export { DIRS, OPACITY_BARRIER };
