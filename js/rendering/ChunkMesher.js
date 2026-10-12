// ChunkMesher.js — hidden-face culling mesher with baked face brightness and vertex AO.
// Pure functions over a padded block array; runs in the meshing worker and on the main thread.
//
// Update #14 §2a: full opaque cubes are greedy-meshed. Per face direction and slice, every visible face whose four
// corners share the same AO level and the same smoothed light (sky and block) is a "flat" face; neighbouring flat
// faces with the same texture tile, rotation and flags merge into one quad, so a field of grass or a cliff is a
// handful of triangles instead of hundreds. Faces with varying corner light / AO keep their own quad, so smooth
// lighting looks exactly as before. Texture coordinates are tile-local (u, v in tile units, repeating with fract()
// in the shader) and every vertex carries its tile index (`tile` attribute) for the texture array (Materials.js).
// Cutout blocks (fancy leaves, glass), water, lava, cross plants and torches keep the per-block mesher.
// §2c: computeVisMask() floods a section's non-opaque cells and reports which pairs of its six faces connect, the
// per-section visibility graph the renderer walks each frame (Visibility.js).

import { PADDED_SIZE, PADDED_STRIDE_Y, WORLD_HEIGHT, SECTION_SIZE, SECTION_COUNT, FACE_BRIGHTNESS, AO_BRIGHTNESS } from '../config/Constants.js';
import { OPAQUE, RENDER_TYPE, PASS, FACE_TILE, FACE_ROT, CULL_SAME, RenderType, RenderPass } from '../blocks/BlockRegistry.js';
import { getTileIndex, TILE_UV_INSET } from './AtlasLayout.js';
import { BlockIds as B } from '../blocks/BlockIds.js';

/** Fast leaves (Update #9 §7) use a derived opaque copy of the leaves texture (TextureAtlas fills the holes). */
const FAST_LEAVES_TILE = getTileIndex('leaves_fast');
import { Direction } from '../utils/Direction.js';
import { TypedArrayBuilder } from '../utils/Pool.js';
import { CORNER_POS, CORNER_UV, NB_OFF, AO_OFF, FACE_ORIGIN, FACE_U, FACE_V, FACE_N } from './FaceTables.js';
import { meshLiquid } from './LiquidMesher.js';
import { torchQuads } from '../blocks/TorchModel.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';

const INSET = TILE_UV_INSET;

/** Accumulates one render pass of a section. */
export class PassBuilder {
  constructor() {
    this.positions = new TypedArrayBuilder(Float32Array, 3 * 1024);
    /** Tile-local texture coordinates (Update #14): 0..w / 0..h over a merged quad, repeated by the shader. */
    this.uvs = new TypedArrayBuilder(Float32Array, 2 * 1024);
    this.colors = new TypedArrayBuilder(Uint8Array, 3 * 1024);
    /** Packed byte per vertex for the shader pipeline (Update #9 §4): face id (bits 0-2, 6 = plant), waving top (8), leaves (16), water (32), AO level (bits 6-7). */
    this.extra = new TypedArrayBuilder(Uint8Array, 1024);
    /** Smoothed light per vertex ×16 (0–240), two bytes: sky (Update #10) and block light (Update #11), the 4-corner averages on the face's outward side. */
    this.lights = new TypedArrayBuilder(Uint8Array, 2 * 1024);
    /** Atlas tile index per vertex: the layer of the texture array (Update #14 §2a). */
    this.tiles = new TypedArrayBuilder(Uint16Array, 1024);
    this.indices = new TypedArrayBuilder(Uint32Array, 6 * 256);
    this.vertexCount = 0;
  }

  reset() {
    this.positions.reset(); this.uvs.reset(); this.colors.reset(); this.extra.reset(); this.lights.reset(); this.tiles.reset(); this.indices.reset();
    this.vertexCount = 0;
  }

  vertex(x, y, z, u, v, shade, extra = 0, light = 240, blockLight = 0, tile = 0) {
    this.positions.push3(x, y, z);
    this.uvs.push2(u, v);
    const c = Math.round(shade * 255);
    this.colors.push3(c, c, c);
    this.extra.push1(extra);
    this.lights.push2(light, blockLight);
    this.tiles.push1(tile);
    this.vertexCount++;
  }

  /** Two triangles over the last four vertices; `flip` selects the other diagonal. */
  quadIndices(flip) {
    const b = this.vertexCount - 4;
    if (flip) this.indices.push6(b + 1, b + 2, b + 3, b + 1, b + 3, b);
    else this.indices.push6(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  /** Exact-size copies for transfer; null when the pass is empty. */
  toResult() {
    if (this.vertexCount === 0) return null;
    const idx32 = this.indices.slice();
    const indices = this.vertexCount < 65536 ? Uint16Array.from(idx32) : idx32;
    return { positions: this.positions.slice(), uvs: this.uvs.slice(), colors: this.colors.slice(), extra: this.extra.slice(), light: this.lights.slice(), tiles: this.tiles.slice(), indices, vertexCount: this.vertexCount };
  }
}

/** Reusable set of the four pass builders. */
export class MeshBuilders {
  constructor() {
    this.passes = [new PassBuilder(), new PassBuilder(), new PassBuilder(), new PassBuilder()]; // opaque, cutout, translucent, lava
  }
  reset() { for (const p of this.passes) p.reset(); }
  results() {
    return { opaque: this.passes[RenderPass.OPAQUE].toResult(), cutout: this.passes[RenderPass.CUTOUT].toResult(), translucent: this.passes[RenderPass.TRANSLUCENT].toResult(), lava: this.passes[RenderPass.LAVA].toResult() };
  }
}

const cornerLight = [240, 240, 240, 240];
const cornerBlock = [0, 0, 0, 0];
/** LIGHT_AVG[count * 64 + sum] = round(sum / count × 16): the smoothed corner light ×16 without a division per corner. */
const LIGHT_AVG = new Uint8Array(5 * 64);
for (let count = 1; count <= 4; count++) for (let sum = 0; sum <= 60; sum++) LIGHT_AVG[count * 64 + sum] = Math.round((sum / count) * 16);

/**
 * Smooth lighting (Update #10): per corner, the average sky light of the four cells touching it on the face's
 * outward side (face neighbour, two sides, diagonal), skipping opaque cells; when both sides are opaque the
 * diagonal is ignored (the AO corner rule, which also stops light leaks). Fast mode: the face neighbour's light.
 */
function faceLights(light, padded, idx, f, useAO, out, outBlock) {
  if (!light) { out[0] = out[1] = out[2] = out[3] = 240; outBlock[0] = outBlock[1] = outBlock[2] = outBlock[3] = 0; return; }
  const nIdx = idx + NB_OFF[f];
  const nOpaque = OPAQUE[padded[nIdx]] === 1;
  const cell = nOpaque ? light[idx] : light[nIdx];
  const n = cell & 15, nb = cell >> 4;
  if (!useAO) { const v = n * 16, vb = nb * 16; out[0] = out[1] = out[2] = out[3] = v; outBlock[0] = outBlock[1] = outBlock[2] = outBlock[3] = vb; return; }
  const aoOff = AO_OFF[f];
  for (let c = 0; c < 4; c++) {
    const o = aoOff[c];
    const s1Op = OPAQUE[padded[idx + o[0]]] === 1, s2Op = OPAQUE[padded[idx + o[1]]] === 1, crOp = OPAQUE[padded[idx + o[2]]] === 1;
    let sum = n, sumB = nb, count = 1;
    if (!s1Op) { const l = light[idx + o[0]]; sum += l & 15; sumB += l >> 4; count++; }
    if (!s2Op) { const l = light[idx + o[1]]; sum += l & 15; sumB += l >> 4; count++; }
    if (!(s1Op && s2Op) && !crOp) { const l = light[idx + o[2]]; sum += l & 15; sumB += l >> 4; count++; }
    out[c] = LIGHT_AVG[count * 64 + sum]; outBlock[c] = LIGHT_AVG[count * 64 + sumB];
  }
}

/** The AO level and the 4-cell light average of every corner of face `f` of the cell at `idx` into cornerAO / cornerLight / cornerBlock. */
const cornerAO = [3, 3, 3, 3];
function faceCorners(padded, idx, f, useAO, light) {
  if (!useAO) { cornerAO[0] = cornerAO[1] = cornerAO[2] = cornerAO[3] = 3; faceLights(light, padded, idx, f, false, cornerLight, cornerBlock); return; }
  const aoOff = AO_OFF[f];
  // One pass per corner for the AO level and the 4-cell light average (both read the same side / diagonal cells).
  const nIdx = idx + NB_OFF[f];
  const nCell = light ? (OPAQUE[padded[nIdx]] === 1 ? light[idx] : light[nIdx]) : 15;
  const nLight = nCell & 15, nBlock = nCell >> 4;
  for (let c = 0; c < 4; c++) {
    const o = aoOff[c];
    const s1 = OPAQUE[padded[idx + o[0]]] === 1 ? 1 : 0;
    const s2 = OPAQUE[padded[idx + o[1]]] === 1 ? 1 : 0;
    const cr = OPAQUE[padded[idx + o[2]]] === 1 ? 1 : 0;
    cornerAO[c] = (s1 && s2) ? 0 : 3 - (s1 + s2 + cr);
    if (light) {
      let sum = nLight, sumB = nBlock, count = 1;
      if (!s1) { const l = light[idx + o[0]]; sum += l & 15; sumB += l >> 4; count++; }
      if (!s2) { const l = light[idx + o[1]]; sum += l & 15; sumB += l >> 4; count++; }
      if (!(s1 && s2) && !cr) { const l = light[idx + o[2]]; sum += l & 15; sumB += l >> 4; count++; }
      cornerLight[c] = LIGHT_AVG[count * 64 + sum]; cornerBlock[c] = LIGHT_AVG[count * 64 + sumB];
    } else { cornerLight[c] = 240; cornerBlock[c] = 0; }
  }
}

/** One face of one block with per-corner AO / light (the non-greedy path; cutout and translucent cubes, uneven faces). */
function addFace(pb, padded, idx, x, ly, z, f, id, h, useAO, tileOverride = -1, light = null) {
  const tile = tileOverride >= 0 ? tileOverride : FACE_TILE[id * 6 + f];
  const bright = FACE_BRIGHTNESS[f];
  const corners = CORNER_POS[f];
  faceCorners(padded, idx, f, useAO, light);
  const ao0 = cornerAO[0], ao1 = cornerAO[1], ao2 = cornerAO[2], ao3 = cornerAO[3];
  const rot = FACE_ROT[id * 6 + f] === 1; // oriented logs: turn the texture 90° so the grain follows the axis
  const flags = f | (id === B.LEAVES ? 16 : 0);
  for (let c = 0; c < 4; c++) {
    const cp = corners[c];
    const uv = CORNER_UV[c];
    const ao = cornerAO[c];
    const iu = rot ? uv[1] : uv[0], iv = rot ? 1 - uv[0] : uv[1];
    pb.vertex(x + cp[0], ly + (cp[1] ? h : 0), z + cp[2], iu ? 1 - INSET : INSET, iv ? 1 - INSET : INSET, bright * AO_BRIGHTNESS[ao], flags | (ao << 6), cornerLight[c], cornerBlock[c], tile);
  }
  // Flip the diagonal so the darkest corners lie on it (avoids anisotropic AO artifacts).
  pb.quadIndices(ao0 + ao2 > ao1 + ao3);
}

function addCross(pb, x, ly, z, id, ownLight = 240, ownBlock = 0) {
  const tile = FACE_TILE[id * 6 + Direction.SOUTH];
  const s = 0.9; // brightness for plants
  const quads = [
    [[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 0]],
    [[1, 0, 1], [0, 0, 0], [0, 1, 0], [1, 1, 1]],
    [[1, 0, 0], [0, 0, 1], [0, 1, 1], [1, 1, 0]],
    [[0, 0, 1], [1, 0, 0], [1, 1, 0], [0, 1, 1]],
  ];
  for (const q of quads) {
    for (let c = 0; c < 4; c++) {
      const p = q[c];
      pb.vertex(x + p[0], ly + p[1], z + p[2], c === 1 || c === 2 ? 1 - INSET : INSET, c >= 2 ? 1 - INSET : INSET, s, 6 | (p[1] ? 8 : 0) | (3 << 6), ownLight, ownBlock, tile); // plant: top vertices wave
    }
    pb.quadIndices(false);
  }
}

/** A torch (Update #11): the TorchModel quads, self-lit (full light on both channels), in the cutout pass. */
function addTorch(pb, x, ly, z, id) {
  const tile = FACE_TILE[id * 6 + Direction.SOUTH];
  for (const quad of torchQuads(BlockRegistry.attachOf(id))) {
    for (let c = 0; c < 4; c++) {
      const p = quad[c];
      pb.vertex(x + p[0], ly + p[1], z + p[2], p[3], p[4], 1, 6 | (3 << 6), 240, 240, tile);
    }
    pb.quadIndices(false);
  }
}

// ---- Greedy meshing of opaque cube faces (Update #14 §2a) ----

/** Per face: the normal axis and the two in-plane axes (index 0 = x, 1 = y, 2 = z) with their signs. */
const AXIS_N = [], AXIS_U = [], AXIS_V = [], SIGN_U = [], SIGN_V = [];
/** Padded-index steps of one grid cell along the face's U / V axes and the index of grid cell (0, 0) in slice 0 (before the y offset). */
const STEP_A = [], STEP_B = [], BASE_IDX = [], STEP_S = [];
const STRIDE = [1, PADDED_STRIDE_Y, PADDED_SIZE];
for (let f = 0; f < 6; f++) {
  const n = FACE_N[f], u = FACE_U[f], v = FACE_V[f];
  AXIS_N[f] = n[0] ? 0 : n[1] ? 1 : 2;
  AXIS_U[f] = u[0] ? 0 : u[1] ? 1 : 2; SIGN_U[f] = u[AXIS_U[f]];
  AXIS_V[f] = v[0] ? 0 : v[1] ? 1 : 2; SIGN_V[f] = v[AXIS_V[f]];
  STEP_A[f] = SIGN_U[f] * STRIDE[AXIS_U[f]];
  STEP_B[f] = SIGN_V[f] * STRIDE[AXIS_V[f]];
  STEP_S[f] = STRIDE[AXIS_N[f]];
  BASE_IDX[f] = PADDED_SIZE + 1 + (SIGN_U[f] > 0 ? 0 : 15 * STRIDE[AXIS_U[f]]) + (SIGN_V[f] > 0 ? 0 : 15 * STRIDE[AXIS_V[f]]);
}
/** Flat-face keys of the slice being merged (0 = no mergeable face), plus their decoded values. */
const KEYS = new Int32Array(256);
const coord = [0, 0, 0];

/** Local (x, ly, z) of grid cell (a, b) in slice s of face f, into `coord`; a / b run along +U / +V of the face. */
function gridCell(f, s, a, b) {
  coord[AXIS_N[f]] = s;
  coord[AXIS_U[f]] = SIGN_U[f] > 0 ? a : 15 - a;
  coord[AXIS_V[f]] = SIGN_V[f] > 0 ? b : 15 - b;
}

/** A merged quad: w cells along the face's U axis, h along V, from grid cell (a, b); flat light / AO. */
function addQuad(pb, f, x, ly, z, w, h, tile, rot, ao, leaf, sky, block) {
  const o = FACE_ORIGIN[f], u = FACE_U[f], v = FACE_V[f];
  const shade = FACE_BRIGHTNESS[f] * AO_BRIGHTNESS[ao];
  const extra = f | (leaf ? 16 : 0) | (ao << 6);
  for (let c = 0; c < 4; c++) {
    const iu = CORNER_UV[c][0], iv = CORNER_UV[c][1];
    const px = x + o[0] + iu * w * u[0] + iv * h * v[0];
    const py = ly + o[1] + iu * w * u[1] + iv * h * v[1];
    const pz = z + o[2] + iu * w * u[2] + iv * h * v[2];
    // Texture coordinates repeat over the quad; a 90° turn for oriented logs (the same turn addFace applies to one face).
    const tu = rot ? (iv ? h - INSET : INSET) : (iu ? w - INSET : INSET);
    const tv = rot ? (iu ? INSET : w - INSET) : (iv ? h - INSET : INSET);
    pb.vertex(px, py, pz, tu, tv, shade, extra, sky, block, tile);
  }
  pb.quadIndices(false);
}

/**
 * Mesh one 16×16×16 section into the builders' passes.
 * @param {Uint8Array} padded 18×18×256 block array
 * @param {number} sy section index 0..15
 * @param {boolean} useAO
 * @param {MeshBuilders} builders
 */
export function meshSection(padded, sy, useAO, builders, fastLeaves = false, light = null) {
  const passes = builders.passes;
  const yStart = sy * SECTION_SIZE;
  // Pass A: everything that is not a greedy opaque cube — plants, torches, liquids, cutout and translucent cubes.
  let anyGreedy = false;
  for (let ly = 0; ly < SECTION_SIZE; ly++) {
    const y = yStart + ly;
    const yBase = y * PADDED_STRIDE_Y;
    for (let z = 0; z < 16; z++) {
      const rowBase = yBase + (z + 1) * PADDED_SIZE + 1;
      for (let x = 0; x < 16; x++) {
        const idx = rowBase + x;
        const id = padded[idx];
        if (id === 0) continue;
        const rt = RENDER_TYPE[id];
        if (rt === RenderType.NONE) continue;
        const fastLeaf = fastLeaves && id === B.LEAVES; // fast leaves: opaque pass, inner faces culled, holes filled
        if (rt === RenderType.CUBE && (fastLeaf || PASS[id] === RenderPass.OPAQUE)) { anyGreedy = true; continue; } // pass B
        const pb = passes[PASS[id]];
        if (rt === RenderType.CROSS) { addCross(pb, x, ly, z, id, light ? (light[idx] & 15) * 16 : 240, light ? (light[idx] >> 4) * 16 : 0); continue; }
        if (rt === RenderType.TORCH) { addTorch(pb, x, ly, z, id); continue; }
        if (rt === RenderType.LIQUID) { meshLiquid(pb, padded, idx, x, ly, z, y, id, light); continue; }
        for (let f = 0; f < 6; f++) {
          let nb;
          if (f === Direction.UP) nb = y === WORLD_HEIGHT - 1 ? 0 : padded[idx + PADDED_STRIDE_Y];
          else if (f === Direction.DOWN && y === 0) nb = 0; // below the world counts as air: bedrock shows from beneath
          else nb = padded[idx + NB_OFF[f]];
          if (nb !== 0) {
            if (OPAQUE[nb] === 1) continue;
            if (nb === id && CULL_SAME[id] === 1) continue; // glass/ice-style; fancy leaves keep inner faces
          }
          addFace(pb, padded, idx, x, ly, z, f, id, 1, useAO, -1, light);
        }
      }
    }
  }
  if (!anyGreedy) return;
  // Pass B: opaque cube faces, face direction by face direction, slice by slice; flat faces merge into quads.
  const pb = passes[RenderPass.OPAQUE];
  for (let f = 0; f < 6; f++) {
    const nOff = NB_OFF[f], stepA = STEP_A[f], stepB = STEP_B[f];
    const vertical = f === Direction.UP || f === Direction.DOWN;
    for (let s = 0; s < 16; s++) {
      let any = false;
      const sliceBase = BASE_IDX[f] + yStart * PADDED_STRIDE_Y + s * STEP_S[f];
      const y = yStart + s; // the cell's world y for vertical faces (the slice index); the world-edge rules only apply to them
      const topEdge = f === Direction.UP && y === WORLD_HEIGHT - 1, bottomEdge = f === Direction.DOWN && y === 0;
      for (let b = 0; b < 16; b++) {
        let idx = sliceBase + b * stepB;
        for (let a = 0; a < 16; a++, idx += stepA) {
          const id = padded[idx];
          KEYS[b * 16 + a] = 0;
          if (id === 0 || RENDER_TYPE[id] !== RenderType.CUBE) continue;
          const fastLeaf = fastLeaves && id === B.LEAVES;
          if (!(fastLeaf || PASS[id] === RenderPass.OPAQUE)) continue;
          const nb = (vertical && (topEdge || bottomEdge)) ? 0 : padded[idx + nOff];
          if (nb !== 0) {
            if (OPAQUE[nb] === 1) continue;
            if (nb === id && (CULL_SAME[id] === 1 || fastLeaf)) continue;
          }
          faceCorners(padded, idx, f, useAO, light);
          const ao = cornerAO[0], sky = cornerLight[0], block = cornerBlock[0];
          if (cornerAO[1] !== ao || cornerAO[2] !== ao || cornerAO[3] !== ao
            || cornerLight[1] !== sky || cornerLight[2] !== sky || cornerLight[3] !== sky
            || cornerBlock[1] !== block || cornerBlock[2] !== block || cornerBlock[3] !== block) {
            // Uneven corners: its own quad with per-vertex AO / light, exactly as before.
            const tile = fastLeaf ? FAST_LEAVES_TILE : FACE_TILE[id * 6 + f];
            const corners = CORNER_POS[f], bright = FACE_BRIGHTNESS[f];
            const rot = FACE_ROT[id * 6 + f] === 1, flags = f | (id === B.LEAVES ? 16 : 0);
            gridCell(f, s, a, b);
            const x = coord[0], ly = coord[1], z = coord[2];
            for (let c = 0; c < 4; c++) {
              const cp = corners[c], uv = CORNER_UV[c], cao = cornerAO[c];
              const iu = rot ? uv[1] : uv[0], iv = rot ? 1 - uv[0] : uv[1];
              pb.vertex(x + cp[0], ly + cp[1], z + cp[2], iu ? 1 - INSET : INSET, iv ? 1 - INSET : INSET, bright * AO_BRIGHTNESS[cao], flags | (cao << 6), cornerLight[c], cornerBlock[c], tile);
            }
            pb.quadIndices(cornerAO[0] + cornerAO[2] > cornerAO[1] + cornerAO[3]);
            continue;
          }
          const tile = fastLeaf ? FAST_LEAVES_TILE : FACE_TILE[id * 6 + f];
          // key: tile (10 bits) | rot | leaf | ao (2) | sky (8) | block (8) | valid
          KEYS[b * 16 + a] = (tile & 1023) | (FACE_ROT[id * 6 + f] === 1 ? 1024 : 0) | (id === B.LEAVES ? 2048 : 0) | (ao << 12) | (sky << 14) | (block << 22) | (1 << 30);
          any = true;
        }
      }
      if (!any) continue;
      // Merge: grow each unclaimed flat face along +U as far as the key matches, then along +V while whole rows match.
      for (let b = 0; b < 16; b++) {
        for (let a = 0; a < 16; a++) {
          const key = KEYS[b * 16 + a];
          if (!key) continue;
          let w = 1;
          while (a + w < 16 && KEYS[b * 16 + a + w] === key) w++;
          let h = 1;
          outer: while (b + h < 16) {
            for (let k = 0; k < w; k++) if (KEYS[(b + h) * 16 + a + k] !== key) break outer;
            h++;
          }
          for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) KEYS[(b + j) * 16 + a + k] = 0;
          gridCell(f, s, a, b);
          addQuad(pb, f, coord[0], coord[1], coord[2], w, h, key & 1023, (key & 1024) !== 0, (key >> 12) & 3, (key & 2048) !== 0, (key >> 14) & 255, (key >> 22) & 255);
        }
      }
    }
  }
}

// ---- Section visibility graph (Update #14 §2c) ----

/** PAIR_BIT[a * 6 + b]: bit index (0..14) of the unordered face pair {a, b}; -1 on the diagonal. */
export const PAIR_BIT = new Int8Array(36).fill(-1);
{
  let k = 0;
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) { PAIR_BIT[a * 6 + b] = k; PAIR_BIT[b * 6 + a] = k; k++; }
}
/** True when faces `a` and `b` of a section connect through non-opaque blocks under `mask`. */
export function visConnected(mask, a, b) { return a === b || (mask & (1 << PAIR_BIT[a * 6 + b])) !== 0; }
export const VIS_ALL = 0x7fff;

const visSeen = new Uint8Array(4096);
const visStack = new Int16Array(4096);
/**
 * Flood every non-opaque cell of the section and record which of its six faces each connected pocket touches; two faces
 * connect when one pocket touches both. All 15 bits for an open section, 0 for a solid one. Cells index as x + z·16 + y·256.
 */
export function computeVisMask(padded, sy) {
  const yStart = sy * SECTION_SIZE;
  visSeen.fill(0);
  let mask = 0;
  for (let start = 0; start < 4096; start++) {
    if (visSeen[start]) continue;
    const sx = start & 15, sz = (start >> 4) & 15, syy = start >> 8;
    if (OPAQUE[padded[(yStart + syy) * PADDED_STRIDE_Y + (sz + 1) * PADDED_SIZE + 1 + sx]] === 1) { visSeen[start] = 1; continue; }
    let faces = 0, top = 0;
    visStack[top++] = start; visSeen[start] = 1;
    while (top > 0) {
      const c = visStack[--top];
      const x = c & 15, z = (c >> 4) & 15, y = c >> 8;
      if (x === 0) faces |= 1 << Direction.WEST; if (x === 15) faces |= 1 << Direction.EAST;
      if (y === 0) faces |= 1 << Direction.DOWN; if (y === 15) faces |= 1 << Direction.UP;
      if (z === 0) faces |= 1 << Direction.NORTH; if (z === 15) faces |= 1 << Direction.SOUTH;
      // 6 neighbours inside the section
      for (let d = 0; d < 6; d++) {
        const nx = x + FACE_N[d][0], ny = y + FACE_N[d][1], nz = z + FACE_N[d][2];
        if (nx < 0 || nx > 15 || ny < 0 || ny > 15 || nz < 0 || nz > 15) continue;
        const n = nx + (nz << 4) + (ny << 8);
        if (visSeen[n]) continue;
        visSeen[n] = 1;
        if (OPAQUE[padded[(yStart + ny) * PADDED_STRIDE_Y + (nz + 1) * PADDED_SIZE + 1 + nx]] === 1) continue;
        visStack[top++] = n;
      }
    }
    if (faces === 0x3f) return VIS_ALL; // every face touched: fully connected, nothing more to learn
    for (let a = 0; a < 6; a++) if (faces & (1 << a)) for (let b = a + 1; b < 6; b++) if (faces & (1 << b)) mask |= 1 << PAIR_BIT[a * 6 + b];
  }
  return mask;
}

/**
 * Mesh every section flagged in `sectionMask`. Returns { sections, transfer } where each section
 * is { sy, opaque, cutout, translucent, lava, visMask } (passes null when empty).
 */
export function meshChunk(padded, sectionMask, useAO, builders = new MeshBuilders(), fastLeaves = false, light = null) {
  const sections = [];
  const transfer = [];
  for (let sy = 0; sy < SECTION_COUNT; sy++) {
    if (!(sectionMask & (1 << sy))) continue;
    builders.reset();
    meshSection(padded, sy, useAO, builders, fastLeaves, light);
    const r = builders.results();
    sections.push({ sy, opaque: r.opaque, cutout: r.cutout, translucent: r.translucent, lava: r.lava, visMask: computeVisMask(padded, sy) });
    for (const pass of [r.opaque, r.cutout, r.translucent, r.lava]) {
      if (!pass) continue;
      transfer.push(pass.positions.buffer, pass.uvs.buffer, pass.colors.buffer, pass.extra.buffer, pass.light.buffer, pass.tiles.buffer, pass.indices.buffer);
    }
  }
  return { sections, transfer };
}
