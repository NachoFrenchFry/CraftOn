// ChunkMesher.js — hidden-face culling mesher with baked face brightness and vertex AO.
// Pure functions over a padded block array; runs in the meshing worker and on the main thread.

import { PADDED_SIZE, PADDED_STRIDE_Y, WORLD_HEIGHT, SECTION_SIZE, SECTION_COUNT, FACE_BRIGHTNESS, AO_BRIGHTNESS } from '../config/Constants.js';
import { OPAQUE, RENDER_TYPE, PASS, FACE_TILE, FACE_ROT, CULL_SAME, RenderType, RenderPass } from '../blocks/BlockRegistry.js';
import { TILE_UVS, getTileIndex } from './AtlasLayout.js';
import { BlockIds as B } from '../blocks/BlockIds.js';

/** Fast leaves (Update #9 §7) use a derived opaque copy of the leaves texture (TextureAtlas fills the holes). */
const FAST_LEAVES_TILE = getTileIndex('leaves_fast');
import { Direction } from '../utils/Direction.js';
import { TypedArrayBuilder } from '../utils/Pool.js';
import { CORNER_POS, CORNER_UV, NB_OFF, AO_OFF } from './FaceTables.js';
import { meshLiquid } from './LiquidMesher.js';
import { torchQuads } from '../blocks/TorchModel.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';

/** Accumulates one render pass of a section. */
export class PassBuilder {
  constructor() {
    this.positions = new TypedArrayBuilder(Float32Array, 3 * 1024);
    this.uvs = new TypedArrayBuilder(Float32Array, 2 * 1024);
    this.colors = new TypedArrayBuilder(Uint8Array, 3 * 1024);
    /** Packed byte per vertex for the shader pipeline (Update #9 §4): face id (bits 0-2, 6 = plant), waving top (8), leaves (16), water (32), AO level (bits 6-7). */
    this.extra = new TypedArrayBuilder(Uint8Array, 1024);
    /** Smoothed light per vertex ×16 (0–240), two bytes: sky (Update #10) and block light (Update #11), the 4-corner averages on the face's outward side. */
    this.lights = new TypedArrayBuilder(Uint8Array, 2 * 1024);
    this.indices = new TypedArrayBuilder(Uint32Array, 6 * 256);
    this.vertexCount = 0;
  }

  reset() {
    this.positions.reset(); this.uvs.reset(); this.colors.reset(); this.extra.reset(); this.lights.reset(); this.indices.reset();
    this.vertexCount = 0;
  }

  vertex(x, y, z, u, v, shade, extra = 0, light = 240, blockLight = 0) {
    this.positions.push3(x, y, z);
    this.uvs.push2(u, v);
    const c = Math.round(shade * 255);
    this.colors.push3(c, c, c);
    this.extra.push1(extra);
    this.lights.push2(light, blockLight);
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
    return { positions: this.positions.slice(), uvs: this.uvs.slice(), colors: this.colors.slice(), extra: this.extra.slice(), light: this.lights.slice(), indices, vertexCount: this.vertexCount };
  }
}

/** Reusable set of three pass builders. */
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

function addFace(pb, padded, idx, x, ly, z, f, id, h, useAO, tileOverride = -1, light = null) {
  const t4 = (tileOverride >= 0 ? tileOverride : FACE_TILE[id * 6 + f]) * 4;
  const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
  const bright = FACE_BRIGHTNESS[f];
  const corners = CORNER_POS[f];
  const aoOff = AO_OFF[f];
  let ao0 = 3, ao1 = 3, ao2 = 3, ao3 = 3;
  if (useAO) {
    // One pass per corner for the AO level and the 4-cell light average (both read the same side / diagonal cells).
    const nIdx = idx + NB_OFF[f];
    const nCell = light ? (OPAQUE[padded[nIdx]] === 1 ? light[idx] : light[nIdx]) : 15;
    const nLight = nCell & 15, nBlock = nCell >> 4;
    for (let c = 0; c < 4; c++) {
      const o = aoOff[c];
      const s1 = OPAQUE[padded[idx + o[0]]] === 1 ? 1 : 0;
      const s2 = OPAQUE[padded[idx + o[1]]] === 1 ? 1 : 0;
      const cr = OPAQUE[padded[idx + o[2]]] === 1 ? 1 : 0;
      const level = (s1 && s2) ? 0 : 3 - (s1 + s2 + cr);
      if (c === 0) ao0 = level; else if (c === 1) ao1 = level; else if (c === 2) ao2 = level; else ao3 = level;
      if (light) {
        let sum = nLight, sumB = nBlock, count = 1;
        if (!s1) { const l = light[idx + o[0]]; sum += l & 15; sumB += l >> 4; count++; }
        if (!s2) { const l = light[idx + o[1]]; sum += l & 15; sumB += l >> 4; count++; }
        if (!(s1 && s2) && !cr) { const l = light[idx + o[2]]; sum += l & 15; sumB += l >> 4; count++; }
        cornerLight[c] = LIGHT_AVG[count * 64 + sum]; cornerBlock[c] = LIGHT_AVG[count * 64 + sumB];
      } else { cornerLight[c] = 240; cornerBlock[c] = 0; }
    }
  } else faceLights(light, padded, idx, f, false, cornerLight, cornerBlock);
  const rot = FACE_ROT[id * 6 + f] === 1; // oriented logs: turn the texture 90° so the grain follows the axis
  const flags = f | (id === B.LEAVES ? 16 : 0);
  for (let c = 0; c < 4; c++) {
    const cp = corners[c];
    const uv = CORNER_UV[c];
    const ao = c === 0 ? ao0 : c === 1 ? ao1 : c === 2 ? ao2 : ao3;
    const iu = rot ? uv[1] : uv[0], iv = rot ? 1 - uv[0] : uv[1];
    pb.vertex(x + cp[0], ly + (cp[1] ? h : 0), z + cp[2], iu ? u1 : u0, iv ? v1 : v0, bright * AO_BRIGHTNESS[ao], flags | (ao << 6), cornerLight[c], cornerBlock[c]);
  }
  // Flip the diagonal so the darkest corners lie on it (avoids anisotropic AO artifacts).
  pb.quadIndices(ao0 + ao2 > ao1 + ao3);
}

function addCross(pb, x, ly, z, id, ownLight = 240, ownBlock = 0) {
  const t4 = FACE_TILE[id * 6 + Direction.SOUTH] * 4;
  const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
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
      pb.vertex(x + p[0], ly + p[1], z + p[2], c === 1 || c === 2 ? u1 : u0, c >= 2 ? v1 : v0, s, 6 | (p[1] ? 8 : 0) | (3 << 6), ownLight, ownBlock); // plant: top vertices wave
    }
    pb.quadIndices(false);
  }
}

/** A torch (Update #11): the TorchModel quads, self-lit (full light on both channels), in the cutout pass. */
function addTorch(pb, x, ly, z, id) {
  const t4 = FACE_TILE[id * 6 + Direction.SOUTH] * 4;
  const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
  const du = u1 - u0, dv = v1 - v0;
  for (const quad of torchQuads(BlockRegistry.attachOf(id))) {
    for (let c = 0; c < 4; c++) {
      const p = quad[c];
      pb.vertex(x + p[0], ly + p[1], z + p[2], u0 + p[3] * du, v0 + p[4] * dv, 1, 6 | (3 << 6), 240, 240);
    }
    pb.quadIndices(false);
  }
}

/**
 * Mesh one 16³ section of a padded chunk into the builders.
 * @param {Uint8Array} padded 18×18×256 block array
 * @param {number} sy section index 0..15
 * @param {boolean} useAO
 * @param {MeshBuilders} builders
 */
export function meshSection(padded, sy, useAO, builders, fastLeaves = false, light = null) {
  const passes = builders.passes;
  const yStart = sy * SECTION_SIZE;
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
        const pb = passes[fastLeaf ? RenderPass.OPAQUE : PASS[id]];
        if (rt === RenderType.CROSS) { addCross(pb, x, ly, z, id, light ? (light[idx] & 15) * 16 : 240, light ? (light[idx] >> 4) * 16 : 0); continue; }
        if (rt === RenderType.TORCH) { addTorch(pb, x, ly, z, id); continue; }
        if (rt === RenderType.LIQUID) { meshLiquid(pb, padded, idx, x, ly, z, y, id, light); continue; }
        const h = 1;
        for (let f = 0; f < 6; f++) {
          let nb;
          if (f === Direction.UP) nb = y === WORLD_HEIGHT - 1 ? 0 : padded[idx + PADDED_STRIDE_Y];
          else if (f === Direction.DOWN && y === 0) nb = 0; // below the world counts as air: bedrock shows from beneath
          else nb = padded[idx + NB_OFF[f]];
          if (nb !== 0) {
            if (OPAQUE[nb] === 1) continue;
            if (nb === id && (CULL_SAME[id] === 1 || fastLeaf)) continue; // glass/ice-style; fancy leaves keep inner faces
          }
          addFace(pb, padded, idx, x, ly, z, f, id, h, useAO, fastLeaf ? FAST_LEAVES_TILE : -1, light);
        }
      }
    }
  }
}

/**
 * Mesh every section flagged in `sectionMask`. Returns { sections, transfer } where each section
 * is { sy, opaque, cutout, translucent } (passes null when empty).
 */
export function meshChunk(padded, sectionMask, useAO, builders = new MeshBuilders(), fastLeaves = false, light = null) {
  const sections = [];
  const transfer = [];
  for (let sy = 0; sy < SECTION_COUNT; sy++) {
    if (!(sectionMask & (1 << sy))) continue;
    builders.reset();
    meshSection(padded, sy, useAO, builders, fastLeaves, light);
    const r = builders.results();
    sections.push({ sy, opaque: r.opaque, cutout: r.cutout, translucent: r.translucent, lava: r.lava });
    for (const pass of [r.opaque, r.cutout, r.translucent, r.lava]) {
      if (!pass) continue;
      transfer.push(pass.positions.buffer, pass.uvs.buffer, pass.colors.buffer, pass.extra.buffer, pass.light.buffer, pass.indices.buffer);
    }
  }
  return { sections, transfer };
}
