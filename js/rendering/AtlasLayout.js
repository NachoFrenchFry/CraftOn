// AtlasLayout.js — deterministic tile placement for the texture atlas. Pure data so both the main
// thread (which paints the atlas) and the meshing worker (which needs UVs) agree on the layout.

import { BLOCK_DEFINITIONS } from '../blocks/BlockDefinitions.js';
import { ITEM_DEFINITIONS } from '../items/ItemDefinitions.js';
import { EXTRA_ATLAS_TEXTURES } from '../config/TextureManifest.js';

export const TILE_SIZE = 16;
export const CRACK_STAGES = 10;
export const MISSING_TEXTURE = 'missing';

/** Inset in texels to stop neighbouring tiles bleeding in (1/32 of a texel). */
const UV_INSET_TEXELS = 1 / 32;

function collectNames() {
  const names = [MISSING_TEXTURE];
  const seen = new Set(names);
  const add = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
  for (const def of BLOCK_DEFINITIONS) {
    if (!def.textures) continue;
    const t = def.textures;
    add(t.all); add(t.top); add(t.bottom); add(t.side);
    add(t.north); add(t.south); add(t.east); add(t.west);
  }
  for (const item of ITEM_DEFINITIONS) add(item.texture);
  for (let i = 0; i < CRACK_STAGES; i++) add('crack_' + i);
  for (const name of EXTRA_ATLAS_TEXTURES) add(name); // particles and other sprites that are not block or item textures
  return names;
}

export const TEXTURE_NAMES = collectNames();
export const TILES_PER_ROW = TEXTURE_NAMES.length <= 256 ? 16 : 32;
export const ATLAS_SIZE = TILES_PER_ROW * TILE_SIZE;

const nameToIndex = new Map();
TEXTURE_NAMES.forEach((n, i) => nameToIndex.set(n, i));

const warnedNames = new Set();
/** Tile index for a texture name; unknown names map to the missing texture and warn once (so a missing atlas entry is noticed). */
export function getTileIndex(name) {
  const i = nameToIndex.get(name);
  if (i === undefined) {
    if (!warnedNames.has(name)) {
      warnedNames.add(name);
      console.warn(`AtlasLayout: unknown texture "${name}" — not a block, item, crack or EXTRA_ATLAS_TEXTURES entry; showing the missing-texture checker.`);
    }
    return 0;
  }
  return i;
}
/** True when a texture name has an atlas tile. */
export function hasTile(name) { return nameToIndex.has(name); }

export function tileColumn(index) { return index % TILES_PER_ROW; }
export function tileRow(index) { return Math.floor(index / TILES_PER_ROW); }

/**
 * UV rectangle of every tile with bleed inset, as [u0, v0, u1, v1] per tile.
 * v is flipped so v1 is the top of the tile (Three.js canvas textures have flipY = true).
 */
export const TILE_UVS = (() => {
  const arr = new Float32Array(TEXTURE_NAMES.length * 4);
  const inset = UV_INSET_TEXELS / ATLAS_SIZE;
  const tileUV = TILE_SIZE / ATLAS_SIZE;
  for (let i = 0; i < TEXTURE_NAMES.length; i++) {
    const c = tileColumn(i), r = tileRow(i);
    arr[i * 4] = c * tileUV + inset;                 // u0 (left)
    arr[i * 4 + 1] = 1 - (r + 1) * tileUV + inset;   // v0 (bottom)
    arr[i * 4 + 2] = (c + 1) * tileUV - inset;       // u1 (right)
    arr[i * 4 + 3] = 1 - r * tileUV - inset;         // v1 (top)
  }
  return arr;
})();

/** Convenience object form. */
export function getUV(name) {
  const i = getTileIndex(name) * 4;
  return { u0: TILE_UVS[i], v0: TILE_UVS[i + 1], u1: TILE_UVS[i + 2], v1: TILE_UVS[i + 3] };
}
