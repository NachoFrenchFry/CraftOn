// Superflat.js — the Superflat world type (Nov 10 2026): the layer list a world is built from, its limits and the one
// normaliser every reader uses (the create form, the save, the host's WELCOME, guests, the chunk workers and the Node
// check), so a bad list is clamped the same way everywhere. A world is `worldType` 'default' or 'superflat'; `flatLayers`
// is a list from the BOTTOM to the TOP, each { block: '<block name>', height: N }. Limits: 1–16 layers, each 1–64 blocks
// tall, 128 blocks in total, solid full-cube placeable blocks only (no liquids, plants, torches or chests). Worker-safe.

import { BlockRegistry, SOLID, RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';
import { BlockIds } from '../blocks/BlockIds.js';

export const WORLD_TYPES = Object.freeze(['default', 'superflat']);
export const WORLD_TYPE_LABELS = Object.freeze({ default: 'Default', superflat: 'Superflat' });
export const FLAT_MAX_LAYERS = 16;
export const FLAT_MAX_LAYER_HEIGHT = 64;
export const FLAT_MAX_HEIGHT = 128;
/** The Classic preset: 1 bedrock, 3 dirt, 1 grass block (bottom to top). */
export const CLASSIC_FLAT_LAYERS = Object.freeze([
  Object.freeze({ block: 'bedrock', height: 1 }),
  Object.freeze({ block: 'dirt', height: 3 }),
  Object.freeze({ block: 'grass_block', height: 1 }),
]);

/** 'superflat' for that value (any case), 'default' for anything else. */
export function worldTypeOf(value) { return String(value || '').toLowerCase() === 'superflat' ? 'superflat' : 'default'; }

/** A block a layer may be made of: a solid full cube that exists as an item (so no liquid, plant, torch, chest or facing variant). */
export function isFlatLayerBlock(id) {
  const def = BlockRegistry.get(id);
  if (!def || id === BlockIds.AIR) return false;
  return SOLID[id] === 1 && RENDER_TYPE[id] === RenderType.CUBE && def.placeable !== false && !def.container && !def.base && !def.hidden;
}

/** The block names a layer may use, in id order (the layer editor's picker). */
export function flatLayerBlockNames() { return BlockRegistry.all().filter((d) => isFlatLayerBlock(d.id)).map((d) => d.name); }

/** The height of a layer list (the y of the first air block). */
export function flatHeight(layers) { let h = 0; for (const l of layers || []) h += l.height; return h; }

/**
 * Clamp and validate a layer list: unknown or disallowed blocks are dropped, heights rounded and kept between 1 and
 * FLAT_MAX_LAYER_HEIGHT, at most FLAT_MAX_LAYERS layers, the total capped at FLAT_MAX_HEIGHT (the last layers are cut),
 * and an empty or invalid list becomes the Classic preset. `changed` says whether anything had to be fixed.
 * @returns {{ layers: {block: string, height: number}[], height: number, changed: boolean }}
 */
export function normalizeFlatLayers(list) {
  let changed = !Array.isArray(list);
  const layers = [];
  let total = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (layers.length >= FLAT_MAX_LAYERS) { changed = true; break; }
    const name = raw && typeof raw.block === 'string' ? raw.block : null;
    const id = name ? BlockRegistry.idOf(name) : BlockIds.AIR;
    if (!name || id === BlockIds.AIR || !isFlatLayerBlock(id)) { changed = true; continue; }
    let h = Math.round(Number(raw.height));
    if (!Number.isFinite(h)) { h = 1; changed = true; }
    if (h < 1) { h = 1; changed = true; } else if (h > FLAT_MAX_LAYER_HEIGHT) { h = FLAT_MAX_LAYER_HEIGHT; changed = true; }
    if (total + h > FLAT_MAX_HEIGHT) { h = FLAT_MAX_HEIGHT - total; changed = true; }
    if (h <= 0) break;
    if (h !== raw.height) changed = true;
    layers.push({ block: name, height: h });
    total += h;
  }
  if (!layers.length) return { layers: CLASSIC_FLAT_LAYERS.map((l) => ({ ...l })), height: flatHeight(CLASSIC_FLAT_LAYERS), changed: true };
  return { layers, height: total, changed };
}

/** The block id of every y from 0 up to the top of the layers (what a superflat column looks like). */
export function flatColumn(layers) {
  const { layers: ls, height } = normalizeFlatLayers(layers);
  const column = new Uint8Array(height);
  let y = 0;
  for (const l of ls) { const id = BlockRegistry.idOf(l.block); for (let k = 0; k < l.height; k++) column[y++] = id; }
  return column;
}

/** The generator options a world's record (or a host's WELCOME) describes: `{ worldType, flatLayers }` with the layers normalised (null for a default world). */
export function worldOptionsOf(meta) {
  const worldType = worldTypeOf(meta && meta.worldType);
  return { worldType, flatLayers: worldType === 'superflat' ? normalizeFlatLayers(meta && meta.flatLayers).layers : null, structuresAvoidRavines: !!(meta && meta.structuresAvoidRavines === true) };
}
