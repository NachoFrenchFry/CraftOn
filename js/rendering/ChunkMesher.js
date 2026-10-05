// ChunkMesher.js — hidden-face culling mesher with baked face brightness and vertex AO.
// Pure functions over a padded block array; runs in the meshing worker and on the main thread.

import { PADDED_SIZE, PADDED_STRIDE_Y, WORLD_HEIGHT, SECTION_SIZE, SECTION_COUNT, FACE_BRIGHTNESS, AO_BRIGHTNESS } from '../config/Constants.js';
import { OPAQUE, RENDER_TYPE, PASS, FACE_TILE, FACE_ROT, CULL_SAME, RenderType, RenderPass } from '../blocks/BlockRegistry.js';
import { TILE_UVS } from './AtlasLayout.js';
import { Direction } from '../utils/Direction.js';
import { TypedArrayBuilder } from '../utils/Pool.js';
import { CORNER_POS, CORNER_UV, NB_OFF, AO_OFF } from './FaceTables.js';
import { meshLiquid } from './LiquidMesher.js';

/** Accumulates one render pass of a section. */
export class PassBuilder {
  constructor() {
    this.positions = new TypedArrayBuilder(Float32Array, 3 * 1024);
    this.uvs = new TypedArrayBuilder(Float32Array, 2 * 1024);
    this.colors = new TypedArrayBuilder(Uint8Array, 3 * 1024);
    this.indices = new TypedArrayBuilder(Uint32Array, 6 * 256);
    this.vertexCount = 0;
  }

  reset() {
    this.positions.reset(); this.uvs.reset(); this.colors.reset(); this.indices.reset();
    this.vertexCount = 0;
  }

  vertex(x, y, z, u, v, shade) {
    this.positions.push3(x, y, z);
    this.uvs.push2(u, v);
    const c = Math.round(shade * 255);
    this.colors.push3(c, c, c);
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
    return { positions: this.positions.slice(), uvs: this.uvs.slice(), colors: this.colors.slice(), indices, vertexCount: this.vertexCount };
  }
}

/** Reusable set of three pass builders. */
export class MeshBuilders {
  constructor() {
    this.passes = [new PassBuilder(), new PassBuilder(), new PassBuilder()];
  }
  reset() { for (const p of this.passes) p.reset(); }
  results() {
    return { opaque: this.passes[RenderPass.OPAQUE].toResult(), cutout: this.passes[RenderPass.CUTOUT].toResult(), translucent: this.passes[RenderPass.TRANSLUCENT].toResult() };
  }
}

function addFace(pb, padded, idx, x, ly, z, f, id, h, useAO) {
  const t4 = FACE_TILE[id * 6 + f] * 4;
  const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
  const bright = FACE_BRIGHTNESS[f];
  const corners = CORNER_POS[f];
  const aoOff = AO_OFF[f];
  let ao0 = 3, ao1 = 3, ao2 = 3, ao3 = 3;
  if (useAO) {
    for (let c = 0; c < 4; c++) {
      const o = aoOff[c];
      const s1 = OPAQUE[padded[idx + o[0]]] === 1 ? 1 : 0;
      const s2 = OPAQUE[padded[idx + o[1]]] === 1 ? 1 : 0;
      const cr = OPAQUE[padded[idx + o[2]]] === 1 ? 1 : 0;
      const level = (s1 && s2) ? 0 : 3 - (s1 + s2 + cr);
      if (c === 0) ao0 = level; else if (c === 1) ao1 = level; else if (c === 2) ao2 = level; else ao3 = level;
    }
  }
  const rot = FACE_ROT[id * 6 + f] === 1; // oriented logs: turn the texture 90° so the grain follows the axis
  for (let c = 0; c < 4; c++) {
    const cp = corners[c];
    const uv = CORNER_UV[c];
    const ao = c === 0 ? ao0 : c === 1 ? ao1 : c === 2 ? ao2 : ao3;
    const iu = rot ? uv[1] : uv[0], iv = rot ? 1 - uv[0] : uv[1];
    pb.vertex(x + cp[0], ly + (cp[1] ? h : 0), z + cp[2], iu ? u1 : u0, iv ? v1 : v0, bright * AO_BRIGHTNESS[ao]);
  }
  // Flip the diagonal so the darkest corners lie on it (avoids anisotropic AO artifacts).
  pb.quadIndices(ao0 + ao2 > ao1 + ao3);
}

function addCross(pb, x, ly, z, id) {
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
      pb.vertex(x + p[0], ly + p[1], z + p[2], c === 1 || c === 2 ? u1 : u0, c >= 2 ? v1 : v0, s);
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
export function meshSection(padded, sy, useAO, builders) {
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
        const pb = passes[PASS[id]];
        if (rt === RenderType.CROSS) { addCross(pb, x, ly, z, id); continue; }
        if (rt === RenderType.LIQUID) { meshLiquid(pb, padded, idx, x, ly, z, y, id); continue; }
        const h = 1;
        for (let f = 0; f < 6; f++) {
          let nb;
          if (f === Direction.UP) nb = y === WORLD_HEIGHT - 1 ? 0 : padded[idx + PADDED_STRIDE_Y];
          else if (f === Direction.DOWN && y === 0) nb = 0; // below the world counts as air: bedrock shows from beneath
          else nb = padded[idx + NB_OFF[f]];
          if (nb !== 0) {
            if (OPAQUE[nb] === 1) continue;
            if (nb === id && CULL_SAME[id] === 1) continue; // glass/ice-style; fancy leaves keep inner faces
          }
          addFace(pb, padded, idx, x, ly, z, f, id, h, useAO);
        }
      }
    }
  }
}

/**
 * Mesh every section flagged in `sectionMask`. Returns { sections, transfer } where each section
 * is { sy, opaque, cutout, translucent } (passes null when empty).
 */
export function meshChunk(padded, sectionMask, useAO, builders = new MeshBuilders()) {
  const sections = [];
  const transfer = [];
  for (let sy = 0; sy < SECTION_COUNT; sy++) {
    if (!(sectionMask & (1 << sy))) continue;
    builders.reset();
    meshSection(padded, sy, useAO, builders);
    const r = builders.results();
    sections.push({ sy, opaque: r.opaque, cutout: r.cutout, translucent: r.translucent });
    for (const pass of [r.opaque, r.cutout, r.translucent]) {
      if (!pass) continue;
      transfer.push(pass.positions.buffer, pass.uvs.buffer, pass.colors.buffer, pass.indices.buffer);
    }
  }
  return { sections, transfer };
}
