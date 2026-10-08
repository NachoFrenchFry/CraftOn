// LightStorage.js — the voxel light data (Update #10): one byte per voxel, low nibble = skyLight (0–15), high
// nibble = blockLight (0–15, reserved for torches). A chunk's light array uses the mesher's padded 18×18×256
// layout (its own 16×16 columns plus a one-block border of the neighbours), so a mesh job needs nothing from
// the neighbouring chunks and the border cells are kept in sync by the incremental updater. Light is never
// saved: it is recomputed from the blocks. Pure and worker-safe.
import { PADDED_SIZE, PADDED_STRIDE_Y, PADDED_LENGTH, WORLD_HEIGHT } from '../../config/Constants.js';

export const SKY = 0;
export const BLOCK = 1;
export const LIGHT_MAX = 15;
/** Opacity of an unloaded / unlit cell: nothing spreads into it. */
export const OPACITY_BARRIER = 255;
export const LIGHT_LENGTH = PADDED_LENGTH;

export function allocLight() { return new Uint8Array(PADDED_LENGTH); }

/** Index of a cell in a chunk's padded light array; lx / lz may be -1..16 (the border), ly 0..255. */
export function lightIndex(lx, ly, lz) { return (lx + 1) + (lz + 1) * PADDED_SIZE + ly * PADDED_STRIDE_Y; }

export function getChannel(byte, channel) { return channel === SKY ? byte & 15 : byte >> 4; }
export function withChannel(byte, channel, value) { return channel === SKY ? (byte & 0xf0) | value : (byte & 0x0f) | (value << 4); }
export function pack(sky, block) { return sky | (block << 4); }

export { WORLD_HEIGHT, PADDED_SIZE, PADDED_STRIDE_Y };
