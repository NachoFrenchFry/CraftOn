// ChunkCoords.js — world ↔ chunk ↔ local coordinate conversions and packed chunk keys. Worker-safe.

import { CHUNK_SHIFT, CHUNK_MASK } from '../config/Constants.js';

// Keys stay inside V8's small-integer range (31 bits): 15 bits per axis, so |cx|, |cz| < 16 384 (±262 144 blocks). A key
// beyond that would be a heap number, and every Map / Set lookup with it (the visibility walk, light floods, chunk queues)
// allocated one — the sampling heap profiler showed it as the biggest allocator while flying.
const KEY_OFFSET = 1 << 14;
const KEY_MUL = 1 << 15;

/** Chunk coordinate containing a world coordinate (works for negatives and fractions). */
export function toChunkCoord(v) { return Math.floor(v) >> CHUNK_SHIFT; }

/** Local coordinate 0..15 within the chunk. */
export function toLocalCoord(v) { return Math.floor(v) & CHUNK_MASK; }

/** Packed numeric key for a chunk (|cx|, |cz| < 2^14; a small integer, see above). */
export function chunkKey(cx, cz) { return (cx + KEY_OFFSET) * KEY_MUL + (cz + KEY_OFFSET); }

export function keyToChunkX(key) { return Math.floor(key / KEY_MUL) - KEY_OFFSET; }
export function keyToChunkZ(key) { return (key % KEY_MUL) - KEY_OFFSET; }

/** Human-readable key used in saves: "cx,cz". */
export function chunkKeyString(cx, cz) { return cx + ',' + cz; }
export function parseChunkKeyString(s) { const [a, b] = s.split(','); return [parseInt(a, 10), parseInt(b, 10)]; }

/** Index into a chunk's block array. */
export function blockIndex(lx, ly, lz) { return lx + (lz << 4) + (ly << 8); }
export function indexToLocalX(i) { return i & 15; }
export function indexToLocalZ(i) { return (i >> 4) & 15; }
export function indexToLocalY(i) { return i >> 8; }
