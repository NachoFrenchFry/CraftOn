// BlockRegistry.js — fast typed-array lookups derived from BlockDefinitions. Worker-safe.

import { BLOCK_DEFINITIONS } from './BlockDefinitions.js';
import { BLOCK_COUNT, BlockIds } from './BlockIds.js';
import { getTileIndex } from '../rendering/AtlasLayout.js';
import { Direction } from '../utils/Direction.js';

export const RenderType = Object.freeze({ NONE: 0, CUBE: 1, CROSS: 2, LIQUID: 3, TORCH: 4 });
export const RenderPass = Object.freeze({ OPAQUE: 0, CUTOUT: 1, TRANSLUCENT: 2, LAVA: 3 });

const RENDER_TYPE_MAP = { none: RenderType.NONE, cube: RenderType.CUBE, cross: RenderType.CROSS, liquid: RenderType.LIQUID, torch: RenderType.TORCH };
const PASS_MAP = { opaque: RenderPass.OPAQUE, cutout: RenderPass.CUTOUT, translucent: RenderPass.TRANSLUCENT, lava: RenderPass.LAVA };

export const OPAQUE = new Uint8Array(BLOCK_COUNT);
export const SOLID = new Uint8Array(BLOCK_COUNT);
export const RENDER_TYPE = new Uint8Array(BLOCK_COUNT);
export const PASS = new Uint8Array(BLOCK_COUNT);
export const BREAK_TIME = new Float32Array(BLOCK_COUNT);
export const NEEDS_SUPPORT = new Uint8Array(BLOCK_COUNT);
/** Pickaxes speed these up. */
export const STONE_TYPE = new Uint8Array(BLOCK_COUNT);
/** 1 = wood-type block (axes mine it faster). */
export const WOOD_TYPE = new Uint8Array(BLOCK_COUNT);
/** 1 = faces between two blocks of this type are culled (glass, water); 0 = kept (fancy leaves). */
export const CULL_SAME = new Uint8Array(BLOCK_COUNT);
/** Light opacity 0–15 (Update #10): air / glass / plants 0, leaves / water / ice 1, full solid blocks 15 (block light completely). */
export const LIGHT_OPACITY = new Uint8Array(BLOCK_COUNT);
/** Block light a block emits, 0–15 (Update #11: torch 14, lava 15). */
export const LIGHT_EMISSION = new Uint8Array(BLOCK_COUNT);
/** Offset (dx, dy, dz) of the block that supports this one, or all zeros: plants / standing torch (0, -1, 0), wall torches the wall they hang on. */
export const SUPPORT_DIR = new Int8Array(BLOCK_COUNT * 3);
/** Atlas tile index per (block, face): FACE_TILE[id * 6 + direction]. */
export const FACE_TILE = new Int16Array(BLOCK_COUNT * 6);
/** Texture name per (block, face). */
export const FACE_TEXTURE = new Array(BLOCK_COUNT * 6).fill(null);
/** 1 where a face's texture is turned 90° (oriented logs keep their grain along the axis). */
export const FACE_ROT = new Uint8Array(BLOCK_COUNT * 6);
const FACE_INDEX = { east: 0, west: 1, up: 2, down: 3, south: 4, north: 5 };

const defsById = new Array(BLOCK_COUNT).fill(null);
const idByName = new Map();
/** base id → { south, north, east, west } ids for blocks with a facing. */
const facingVariants = new Map();
/** base id → { x, y, z } ids for blocks with an axis (logs). */
const axisVariants = new Map();
/** base id → { north, south, east, west } wall variants of a block that hangs on a wall (torches). */
const attachVariants = new Map();

function faceTextureNames(t) {
  if (!t) return [null, null, null, null, null, null];
  const side = t.side || t.all;
  return [
    t.east || side, t.west || side,
    t.top || t.all, t.bottom || t.all,
    t.south || side, t.north || side,
  ];
}

for (const def of BLOCK_DEFINITIONS) {
  const id = def.id;
  defsById[id] = def;
  idByName.set(def.name, id);
  OPAQUE[id] = def.opaque ? 1 : 0;
  SOLID[id] = def.solid ? 1 : 0;
  RENDER_TYPE[id] = RENDER_TYPE_MAP[def.renderType] ?? RenderType.NONE;
  PASS[id] = PASS_MAP[def.pass] ?? RenderPass.OPAQUE;
  BREAK_TIME[id] = def.breakTime;
  NEEDS_SUPPORT[id] = def.needsSupport ? 1 : 0;
  LIGHT_OPACITY[id] = def.lightOpacity !== undefined ? def.lightOpacity : def.opaque ? 15 : (RENDER_TYPE[id] === RenderType.CROSS || RENDER_TYPE[id] === RenderType.TORCH || RENDER_TYPE[id] === RenderType.NONE) ? 0 : 1;
  LIGHT_EMISSION[id] = def.lightEmission || 0;
  if (def.needsSupport) SUPPORT_DIR[id * 3 + 1] = -1;
  if (def.attach) { const d = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }[def.attach]; SUPPORT_DIR[id * 3] = d[0]; SUPPORT_DIR[id * 3 + 1] = d[1]; SUPPORT_DIR[id * 3 + 2] = d[2]; }
  STONE_TYPE[id] = def.stoneType ? 1 : 0;
  WOOD_TYPE[id] = def.woodType ? 1 : 0;
  CULL_SAME[id] = def.cullSameType === false ? 0 : 1;
  const names = faceTextureNames(def.textures);
  for (let f = 0; f < 6; f++) {
    FACE_TEXTURE[id * 6 + f] = names[f];
    FACE_TILE[id * 6 + f] = names[f] ? getTileIndex(names[f]) : 0;
  }
  if (def.rotateFaces) for (const face of def.rotateFaces) FACE_ROT[id * 6 + FACE_INDEX[face]] = 1;
}

for (const def of BLOCK_DEFINITIONS) {
  if (def.axis) {
    const baseId = def.base ? idByName.get(def.base) : def.id;
    if (!axisVariants.has(baseId)) axisVariants.set(baseId, {});
    axisVariants.get(baseId)[def.axis] = def.id;
  }
  if (def.attach) {
    const baseId = idByName.get(def.base);
    if (!attachVariants.has(baseId)) attachVariants.set(baseId, {});
    attachVariants.get(baseId)[def.attach] = def.id;
  }
  if (!def.facing) continue;
  const baseId = idByName.get(def.base);
  if (!facingVariants.has(baseId)) facingVariants.set(baseId, {});
  facingVariants.get(baseId)[def.facing] = def.id;
}

/**
 * Render an opaque cube block in the cutout pass instead (its texture turned out to have transparent
 * pixels). Applied on the main thread after the atlas loads and mirrored in the mesh worker.
 */
export function markCutout(id) {
  if (!defsById[id] || RENDER_TYPE[id] !== RenderType.CUBE) return false;
  const changed = OPAQUE[id] === 1 || PASS[id] !== RenderPass.CUTOUT;
  OPAQUE[id] = 0;
  PASS[id] = RenderPass.CUTOUT;
  CULL_SAME[id] = 0;
  return changed;
}

export const BlockRegistry = {
  /** Definition object for an id (null for unknown). */
  get(id) { return defsById[id] || null; },
  idOf(name) { return idByName.has(name) ? idByName.get(name) : BlockIds.AIR; },
  nameOf(id) { const d = defsById[id]; return d ? d.name : 'unknown'; },
  displayName(id) { const d = defsById[id]; return d ? d.displayName : 'Unknown'; },
  isOpaque(id) { return OPAQUE[id] === 1; },
  isSolid(id) { return SOLID[id] === 1; },
  isAir(id) { return id === BlockIds.AIR; },
  isLiquid(id) { return RENDER_TYPE[id] === RenderType.LIQUID; },
  isCross(id) { return RENDER_TYPE[id] === RenderType.CROSS; },
  lightOpacity(id) { return LIGHT_OPACITY[id]; },
  needsSupport(id) { return NEEDS_SUPPORT[id] === 1; },
  breakTime(id) { return BREAK_TIME[id]; },
  soundGroup(id) { const d = defsById[id]; return d ? d.soundGroup : 'stone'; },
  /** Name of the item dropped when broken (a block or item name), or null. Resolve with ItemRegistry.idOf. */
  dropName(id) { const d = defsById[id]; return d && d.drops ? d.drops : null; },
  isStoneType(id) { return STONE_TYPE[id] === 1; },
  isWoodType(id) { return WOOD_TYPE[id] === 1; },
  /** 'crafting_table' | 'furnace' | null. */
  stationOf(id) { const d = defsById[id]; return d && d.station ? d.station : null; },
  /** The base block of a facing variant (itself for ordinary blocks). */
  baseOf(id) { const d = defsById[id]; return d && d.base ? idByName.get(d.base) : id; },
  /** Variant of a facing block whose front points toward `facing` ('north' | 'south' | 'east' | 'west'). */
  facingVariant(baseId, facing) { const v = facingVariants.get(baseId); return v && v[facing] !== undefined ? v[facing] : baseId; },
  hasFacing(id) { return facingVariants.has(this.baseOf(id)); },
  /** Log-style blocks: the variant lying along `axis` ('x' | 'y' | 'z'). */
  axisVariant(baseId, axis) { const v = axisVariants.get(baseId); return v && v[axis] !== undefined ? v[axis] : baseId; },
  hasAxis(id) { return axisVariants.has(this.baseOf(id)); },
  /** 'x' | 'y' | 'z' for oriented blocks, null otherwise. */
  axisOf(id) { const d = defsById[id]; return d && d.axis ? d.axis : null; },
  /** Wall variant of a torch-like block hanging on the wall to `side` ('north' | 'south' | 'east' | 'west'), or the base when it has none. */
  attachVariant(baseId, side) { const v = attachVariants.get(baseId); return v && v[side] !== undefined ? v[side] : baseId; },
  hasAttach(id) { return attachVariants.has(this.baseOf(id)); },
  attachOf(id) { const d = defsById[id]; return d && d.attach ? d.attach : null; },
  isTorch(id) { return RENDER_TYPE[id] === RenderType.TORCH; },
  lightEmission(id) { return LIGHT_EMISSION[id]; },
  /** [dx, dy, dz] of the block that must stay for this one to stay, or null. */
  supportDir(id) { const i = id * 3; return SUPPORT_DIR[i] || SUPPORT_DIR[i + 1] || SUPPORT_DIR[i + 2] ? [SUPPORT_DIR[i], SUPPORT_DIR[i + 1], SUPPORT_DIR[i + 2]] : null; },
  dropChance(id) { const d = defsById[id]; return d && d.dropChance !== undefined ? d.dropChance : 1; },
  faceTexture(id, dir) { return FACE_TEXTURE[id * 6 + dir]; },
  faceTile(id, dir) { return FACE_TILE[id * 6 + dir]; },
  topTexture(id) { return FACE_TEXTURE[id * 6 + Direction.UP]; },
  sideTexture(id) { return FACE_TEXTURE[id * 6 + Direction.SOUTH]; },
  /** Can a block be placed into / does the player walk through this block? */
  isReplaceable(id) { return id === BlockIds.AIR || RENDER_TYPE[id] === RenderType.LIQUID || RENDER_TYPE[id] === RenderType.CROSS; },
  /** Every definition (including air) in id order. */
  all() { return BLOCK_DEFINITIONS; },
  count: BLOCK_COUNT,
};
