// StructureRegistry.js — the structure data files (structures/*.json, see README "Structures") parsed once: palette
// entries resolved to block ids (with their 0 / 90 / 180 / 270° variants: log axis and facing rotate too), the run-length
// encoded block grid decoded, containers, placement rules and structure groups (pieces placed with offsets from one
// start). Worker-safe (no Three.js): the chunk worker fetches the files, Node checks read them with fs, and both hand
// the parsed objects to StructureRegistry.fromList().

import { BlockIds as B } from '../blocks/BlockIds.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { LootTables } from './LootTables.js';
import { hashSeed } from '../utils/Random.js';

/** The palette id meaning "leave the existing terrain alone" (never a real block id). */
export const VOID = 255;
/** Facings in clockwise order seen from above (south → west → north → east), so a 90° turn is +1. */
export const FACINGS = ['south', 'west', 'north', 'east'];
const AXES = ['x', 'y', 'z'];
const MODES = ['surface', 'ocean_surface', 'underground', 'tree'];
const warned = new Set();

function warnOnce(key, text) { if (warned.has(key)) return; warned.add(key); console.warn('Structures: ' + text); }

/**
 * One palette entry: "planks", "log[axis=y]", "chest[facing=south]", "torch[facing=north]" … → the block id for each of
 * the four rotations (index = quarter turns clockwise). Unknown names become structure_void with one console warning.
 */
export function resolvePaletteEntry(entry) {
  const m = /^([a-z_0-9]+)(?:\[([a-z]+)=([a-z]+)\])?$/.exec(String(entry).trim());
  if (!m) { warnOnce('bad:' + entry, `palette entry "${entry}" is malformed; treated as structure_void`); return [VOID, VOID, VOID, VOID]; }
  const [, name, key, value] = m;
  if (name === 'structure_void') return [VOID, VOID, VOID, VOID];
  if (name === 'air') return [B.AIR, B.AIR, B.AIR, B.AIR];
  const base = BlockRegistry.idOf(name);
  if (base === B.AIR) { warnOnce('unknown:' + name, `unknown block "${name}" in a structure palette; treated as structure_void`); return [VOID, VOID, VOID, VOID]; }
  if (key === 'axis') {
    const a = AXES.indexOf(value);
    if (a < 0) { warnOnce('axis:' + value, `unknown axis "${value}" for ${name}; using y`); return [base, base, base, base]; }
    const forAxis = (axis) => (axis === 'x' ? B.LOG_X : axis === 'z' ? B.LOG_Z : B.LOG);
    if (base !== B.LOG) return [base, base, base, base]; // only logs have an axis
    if (value === 'y') return [base, base, base, base];
    return [0, 1, 2, 3].map((r) => forAxis(r % 2 === 0 ? value : value === 'x' ? 'z' : 'x'));
  }
  if (key === 'facing') {
    const f = FACINGS.indexOf(value);
    if (f < 0) { warnOnce('facing:' + value, `unknown facing "${value}" for ${name}; using south`); return [base, base, base, base]; }
    // Wall torches: torch[facing=north] hangs on the wall to its north (TORCH_N); the facing turns with the structure.
    if (base === B.TORCH) { const wall = { south: B.TORCH_S, west: B.TORCH_W, north: B.TORCH_N, east: B.TORCH_E }; return [0, 1, 2, 3].map((r) => wall[FACINGS[(f + r) & 3]]); }
    if (!BlockRegistry.hasFacing(base)) return [base, base, base, base];
    return [0, 1, 2, 3].map((r) => BlockRegistry.facingVariant(base, FACINGS[(f + r) & 3]));
  }
  if (key) warnOnce('state:' + key, `unknown state "${key}" on ${name}; ignored`);
  return [base, base, base, base];
}

/** Decode "count x paletteIndex, …" into a Uint8Array of palette indices (x fastest, then z, then y). */
export function decodeRle(text, total) {
  const out = new Uint8Array(total);
  let n = 0;
  for (const seg of String(text).split(',')) {
    if (!seg) continue;
    const m = /^\s*(\d+)x(\d+)\s*$/.exec(seg);
    if (!m) throw new Error('bad RLE segment "' + seg + '"');
    const count = +m[1], idx = +m[2];
    if (n + count > total) throw new Error('RLE longer than the block grid');
    out.fill(idx, n, n + count);
    n += count;
  }
  if (n !== total) throw new Error(`RLE covers ${n} cells, the grid has ${total}`);
  return out;
}

/** Encode palette indices (x fastest, then z, then y) as "count x index, …". */
export function encodeRle(indices) {
  const parts = [];
  let i = 0;
  while (i < indices.length) {
    const v = indices[i];
    let j = i + 1;
    while (j < indices.length && indices[j] === v) j++;
    parts.push((j - i) + 'x' + v);
    i = j;
  }
  return parts.join(',');
}

/** Rotate a local offset (dx, dz) from the anchor by r quarter turns clockwise (seen from above). */
export function rotateOffset(dx, dz, r) {
  switch (r & 3) {
    case 1: return [-dz, dx];
    case 2: return [-dx, -dz];
    case 3: return [dz, -dx];
    default: return [dx, dz];
  }
}

/** The inverse of rotateOffset: a rotated offset back to the structure's own frame. */
export function unrotateOffset(rx, rz, r) {
  switch (r & 3) {
    case 1: return [rz, -rx];
    case 2: return [-rx, -rz];
    case 3: return [-rz, rx];
    default: return [rx, rz];
  }
}

export class Structure {
  constructor(json) {
    this.name = String(json.name);
    this.group = Array.isArray(json.pieces);
    const p = json.placement || {};
    this.placement = {
      biomes: Array.isArray(p.biomes) ? p.biomes.map((b) => String(b).toLowerCase()) : [],
      mode: MODES.includes(p.mode) ? p.mode : 'surface',
      spacing: Math.max(2, p.spacing | 0 || 24),
      separation: Math.max(0, p.separation | 0),
      chance: typeof p.chance === 'number' ? p.chance : 1,
      rotate: !!p.rotate,
      foundation: p.foundation ? resolvePaletteEntry(p.foundation)[0] : 0,
      clearAbove: !!p.clearAbove,
      yRange: Array.isArray(p.yRange) && p.yRange.length === 2 ? [p.yRange[0] | 0, p.yRange[1] | 0] : [10, 50],
      maxSlope: typeof p.maxSlope === 'number' ? p.maxSlope : 4,
    };
    if (this.placement.separation * 2 >= this.placement.spacing) this.placement.separation = Math.floor((this.placement.spacing - 1) / 2);
    this.salt = hashSeed(this.name);
    if (this.group) {
      this.size = [0, 0, 0]; this.anchor = [0, 0, 0]; this.indices = null; this.palette = []; this.containers = [];
      this.pieces = json.pieces.map((pc) => ({ structure: String(pc.structure), offset: Array.isArray(pc.offset) ? pc.offset.map((v) => v | 0) : [0, 0, 0], rotation: pc.rotation === 'random' ? 'random' : (pc.rotation | 0) & 3, chance: typeof pc.chance === 'number' ? pc.chance : 1 }));
      this.paths = json.paths ? { block: resolvePaletteEntry(json.paths.block || 'gravel')[0] || B.GRAVEL } : null;
    } else {
      this.size = json.size.map((v) => v | 0);
      this.anchor = (json.anchor || [0, 0, 0]).map((v) => v | 0);
      const [sx, sy, sz] = this.size;
      if (!(sx > 0 && sy > 0 && sz > 0)) throw new Error(this.name + ': bad size');
      this.palette = json.palette.map(resolvePaletteEntry);
      this.indices = decodeRle(json.blocks, sx * sy * sz);
      for (let i = 0; i < this.indices.length; i++) if (this.indices[i] >= this.palette.length) throw new Error(this.name + ': palette index out of range');
      this.containers = (json.containers || []).map((c) => ({ pos: c.pos.map((v) => v | 0), loot: String(c.loot), chance: typeof c.chance === 'number' ? c.chance : 1 }));
      this.pieces = null; this.paths = null;
      /** Block ids per rotation, built on first use. */
      this._ids = [null, null, null, null];
    }
    /** Horizontal reach from the anchor (blocks), for chunk overlap tests. Groups get it from their pieces (see registry). */
    this.reach = this.group ? 0 : Math.max(this.size[0], this.size[2]);
    this.height = this.group ? 0 : this.size[1];
  }

  /** Block ids (VOID for structure_void) for rotation r, same layout as the indices. */
  ids(r) {
    r &= 3;
    if (this._ids[r]) return this._ids[r];
    const out = new Uint8Array(this.indices.length);
    const pal = this.palette.map((ids) => ids[r]);
    for (let i = 0; i < out.length; i++) out[i] = pal[this.indices[i]];
    this._ids[r] = out;
    return out;
  }
}

export class StructureRegistry {
  /** @param {object[]} files parsed structures/<name>.json objects @param {object} loot parsed structures/loot.json */
  static fromList(files, loot) {
    const reg = new StructureRegistry();
    for (const f of files) {
      try { const s = new Structure(f); reg.byName.set(s.name, s); reg.list.push(s); } catch (e) { console.warn('Structures: skipping ' + (f && f.name) + ': ' + (e && e.message)); }
    }
    reg.loot = new LootTables(loot || {});
    // Groups: reach and height from their pieces; pieces naming unknown structures are dropped.
    for (const s of reg.list) {
      if (!s.group) continue;
      s.pieces = s.pieces.filter((pc) => { const ok = reg.byName.has(pc.structure) && !reg.byName.get(pc.structure).group; if (!ok) console.warn(`Structures: ${s.name} refers to unknown piece "${pc.structure}"`); return ok; });
      for (const pc of s.pieces) { const t = reg.byName.get(pc.structure); s.reach = Math.max(s.reach, Math.abs(pc.offset[0]) + Math.abs(pc.offset[2]) + t.reach); s.height = Math.max(s.height, t.height + Math.abs(pc.offset[1])); }
    }
    reg.maxReach = reg.list.reduce((m, s) => Math.max(m, s.reach), 0);
    return reg;
  }

  constructor() {
    /** @type {Map<string, Structure>} */
    this.byName = new Map();
    /** @type {Structure[]} */
    this.list = [];
    this.loot = new LootTables({});
    this.maxReach = 0;
  }
}
