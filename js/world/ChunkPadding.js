// ChunkPadding.js — builds the 18×18×256 padded block array the mesher reads, so faces on chunk
// borders are culled against the neighbouring chunks' blocks. Worker-safe layout, main-thread builder.

import { CHUNK_SIZE, WORLD_HEIGHT, PADDED_SIZE, PADDED_STRIDE_Y, PADDED_LENGTH } from '../config/Constants.js';

export function paddedIndex(lx, ly, lz) {
  return (lx + 1) + (lz + 1) * PADDED_SIZE + ly * PADDED_STRIDE_Y;
}

/**
 * Fill `out` (Uint8Array of PADDED_LENGTH) with the chunk's blocks and one-block borders from the
 * four horizontal neighbours (missing neighbours read as air). Corners are never sampled.
 */
export function buildPaddedChunk(world, cx, cz, out) {
  out.fill(0);
  const center = world.getChunk(cx, cz);
  if (!center) return out;
  const src = center.blocks;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const yBase = y * PADDED_STRIDE_Y;
    const sBase = y << 8;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const dst = yBase + (z + 1) * PADDED_SIZE + 1;
      const s = sBase + (z << 4);
      for (let x = 0; x < CHUNK_SIZE; x++) out[dst + x] = src[s + x];
    }
  }
  const west = world.getChunk(cx - 1, cz);
  const east = world.getChunk(cx + 1, cz);
  const north = world.getChunk(cx, cz - 1);
  const south = world.getChunk(cx, cz + 1);
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const yBase = y * PADDED_STRIDE_Y;
    const sBase = y << 8;
    if (west) { const b = west.blocks; for (let z = 0; z < 16; z++) out[yBase + (z + 1) * PADDED_SIZE] = b[sBase + (z << 4) + 15]; }
    if (east) { const b = east.blocks; for (let z = 0; z < 16; z++) out[yBase + (z + 1) * PADDED_SIZE + 17] = b[sBase + (z << 4)]; }
    if (north) { const b = north.blocks; for (let x = 0; x < 16; x++) out[yBase + x + 1] = b[sBase + (15 << 4) + x]; }
    if (south) { const b = south.blocks; for (let x = 0; x < 16; x++) out[yBase + 17 * PADDED_SIZE + x + 1] = b[sBase + x]; }
  }
  // Diagonal corner columns (only needed for ambient occlusion at chunk corners).
  const nw = world.getChunk(cx - 1, cz - 1), ne = world.getChunk(cx + 1, cz - 1);
  const sw = world.getChunk(cx - 1, cz + 1), se = world.getChunk(cx + 1, cz + 1);
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const yBase = y * PADDED_STRIDE_Y;
    const sBase = y << 8;
    if (nw) out[yBase] = nw.blocks[sBase + (15 << 4) + 15];
    if (ne) out[yBase + 17] = ne.blocks[sBase + (15 << 4)];
    if (sw) out[yBase + 17 * PADDED_SIZE] = sw.blocks[sBase + 15];
    if (se) out[yBase + 17 * PADDED_SIZE + 17] = se.blocks[sBase];
  }
  return out;
}

export function allocPadded() { return new Uint8Array(PADDED_LENGTH); }
