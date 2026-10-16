// PackedVertex.js — the 8-byte chunk vertex: two uint32 words per vertex (`attribute uvec2 data`), decoded in the
// vertex shader (PACKED_VERTEX_GLSL) and, for tests and tools, by unpackVertex(). Replaces the 28-byte layout
// (position ×3 floats, uv ×2 floats, colour, extra, light ×2, tile) with no change on screen: position, tile-local
// texture coordinates, face normal, shade (face brightness × ambient occlusion, as the byte the colour attribute
// carried), smoothed light and the flags are all derived from the two words.
//
//   word A (cube faces, plants, liquids; face 0..6)        word B
//     bits  0-4   x, 0..16 (chunk-local)                    bits  0-9   tile (texture-array layer)
//     bits  5-13  y, 0..256 (chunk-local)                   bits 10-17  sky light ×16, 0..240
//     bits 14-18  z, 0..16                                  bits 18-25  block light ×16, 0..240
//     bits 19-20  corner index (CORNER_UV)                  bits 26-27  ambient-occlusion level
//     bits 21-24  quad width − 1 (tile-local u spans it)    bit 28 rotated texture (oriented logs)
//     bits 25-28  quad height − 1                           bit 29 leaves (waving)  bit 30 water  bit 31 waving plant top
//     bits 29-31  face (Direction id; 6 = plant)
//   word A (torch model; face 7)                            word B (torch model)
//     bits  0-3 cell x, 4-11 cell y, 12-15 cell z           bits  0-9   tile
//     bits 16-19, 20-23, 24-27  x, y, z in sixteenths       bits 10-14  u in sixteenths, 15-19 v in sixteenths
//     bits 29-31  7                                         bits 20-22  wall attach (0 standing, 1 N, 2 S, 3 E, 4 W)
// A torch is stored as the standing model; the wall tilt (TorchModel.toWall) is applied by the decoder, so the words
// stay integers. Liquid corner heights are not sixteenths: liquid passes carry a third attribute, `yf` (float32 y).
// Worker-safe (no Three).

import { TILE_UV_INSET } from './AtlasLayout.js';
import { FACE_BRIGHTNESS, AO_BRIGHTNESS } from '../config/Constants.js';
import { toWall, TORCH_TILT } from '../blocks/TorchModel.js';

export const FACE_PLANT = 6;
export const FACE_MODEL = 7;
export const FLAG_ROT = 1 << 28;
export const FLAG_LEAVES = 1 << 29;
export const FLAG_WATER = 1 << 30;
export const FLAG_TOPWAVE = 1 << 31; // negative as an int32; stored into a Uint32Array it is bit 31
export const ATTACH_CODE = Object.freeze({ north: 1, south: 2, east: 3, west: 4 });
export const ATTACH_NAME = Object.freeze([null, 'north', 'south', 'east', 'west']);
export const BYTES_PER_VERTEX = 8;

/**
 * SHADE_BYTES[face * 4 + ao]: the vertex colour byte of a face at an AO level, exactly as the old colour attribute held it
 * (Math.round(brightness × 255)): faces 0..5 FACE_BRIGHTNESS × AO_BRIGHTNESS, 6 (plants) 0.9 × AO, 7 (torches) 1.
 */
export const SHADE_BYTES = new Uint8Array(32);
for (let f = 0; f < 8; f++) for (let ao = 0; ao < 4; ao++) {
  const bright = f < 6 ? FACE_BRIGHTNESS[f] : f === 6 ? 0.9 : 1;
  SHADE_BYTES[f * 4 + ao] = Math.round(bright * (f === 7 ? 1 : AO_BRIGHTNESS[ao]) * 255);
}

/** Word A of a cube / plant / liquid vertex (chunk-local integer position, corner index, quad size, face). */
export function packA(x, y, z, corner, w, h, face) {
  return x | (y << 5) | (z << 14) | (corner << 19) | ((w - 1) << 21) | ((h - 1) << 25) | (face << 29);
}
/** Word B: tile, light ×16 (0..240), AO level and the FLAG_* bits. */
export function packB(tile, sky, block, ao, flags) {
  return tile | (sky << 10) | (block << 18) | (ao << 26) | flags;
}
/** Word A of a torch-model vertex: the cell and the standing model's position in sixteenths. */
export function packModelA(cx, cy, cz, fx, fy, fz) {
  return cx | (cy << 4) | (cz << 12) | (fx << 16) | (fy << 20) | (fz << 24) | (FACE_MODEL << 29);
}
/** Word B of a torch-model vertex: tile, texture coordinates in sixteenths and the wall attach code. */
export function packModelB(tile, u16, v16, attach) {
  return tile | (u16 << 10) | (v16 << 15) | (attach << 20);
}

/**
 * Decode one vertex into `out` (x, y, z, u, v, face, corner, w, h, tile, sky, block, ao, rot, leaves, water, topWave,
 * shade (0..255), model, attach). `yf` (liquid passes) replaces the integer y. The torch tilt is applied like the shader.
 */
export function unpackVertex(a, b, out = {}, yf = undefined) {
  a >>>= 0; b >>>= 0;
  const face = a >>> 29;
  out.tile = b & 1023;
  if (face === FACE_MODEL) {
    const attach = (b >>> 20) & 7;
    let p = [((a >>> 16) & 15) / 16, ((a >>> 20) & 15) / 16, ((a >>> 24) & 15) / 16, ((b >>> 10) & 31) / 16, ((b >>> 15) & 31) / 16];
    if (attach) p = toWall(p, ATTACH_NAME[attach]);
    out.x = (a & 15) + p[0]; out.y = ((a >>> 4) & 255) + p[1]; out.z = ((a >>> 12) & 15) + p[2];
    out.u = p[3]; out.v = p[4];
    out.face = FACE_PLANT; out.corner = 0; out.w = 1; out.h = 1;
    out.sky = 240; out.block = 240; out.ao = 3; out.rot = false; out.leaves = false; out.water = false; out.topWave = false;
    out.shade = 255; out.model = true; out.attach = attach;
    return out;
  }
  out.x = a & 31; out.y = yf !== undefined ? yf : (a >>> 5) & 511; out.z = (a >>> 14) & 31;
  const corner = (a >>> 19) & 3, w = ((a >>> 21) & 15) + 1, h = ((a >>> 25) & 15) + 1;
  const iu = corner === 1 || corner === 2, iv = corner >= 2;
  const rot = ((b >>> 28) & 1) === 1;
  if (rot) { out.u = iv ? h - TILE_UV_INSET : TILE_UV_INSET; out.v = iu ? TILE_UV_INSET : w - TILE_UV_INSET; }
  else { out.u = iu ? w - TILE_UV_INSET : TILE_UV_INSET; out.v = iv ? h - TILE_UV_INSET : TILE_UV_INSET; }
  out.face = face; out.corner = corner; out.w = w; out.h = h;
  out.sky = (b >>> 10) & 255; out.block = (b >>> 18) & 255; out.ao = (b >>> 26) & 3;
  out.rot = rot; out.leaves = ((b >>> 29) & 1) === 1; out.water = ((b >>> 30) & 1) === 1; out.topWave = (b >>> 31) === 1;
  out.shade = SHADE_BYTES[face * 4 + out.ao];
  out.model = false; out.attach = 0;
  return out;
}

/** The old `extra` byte of a decoded vertex (face | topWave 8 | leaves 16 | water 32 | ao << 6), for tools that still think in it. */
export function extraOf(v) {
  return v.face | (v.topWave ? 8 : 0) | (v.leaves ? 16 : 0) | (v.water ? 32 : 0) | (v.ao << 6);
}

const f = (x) => { const s = String(x); return s.includes('.') || s.includes('e') ? s : s + '.0'; };

/**
 * The decoder for every chunk material (plain, lit and the shadow depth pass): `craftonDecode()` reads the `data`
 * attribute (and `yf` under CRAFTON_LIQUID_Y) into a CraftonVertex. CRAFTON_FLAT_SHADE (lava) makes the shade 1.
 */
export const PACKED_VERTEX_GLSL = `
attribute uvec2 data;
#ifdef CRAFTON_LIQUID_Y
attribute float yf;
#endif
const float CRAFTON_INSET = ${f(TILE_UV_INSET)};
const float CRAFTON_SHADE[32] = float[32](${Array.from(SHADE_BYTES, (b) => f(b / 255)).join(', ')});
struct CraftonVertex { vec3 pos; vec2 uv; float face; float ao; vec2 light; float tile; float shade; float topWave; float leaves; float water; };
vec3 craftonTorchWall(vec3 p, uint attach) {
  vec2 w = attach == 1u ? vec2(0.0, -1.0) : attach == 2u ? vec2(0.0, 1.0) : attach == 3u ? vec2(1.0, 0.0) : vec2(-1.0, 0.0);
  float dx = -w.x, dz = -w.y, sx = -w.y, sz = w.x;
  float hx = p.x - 0.5, hz = p.z - 0.5, hy = p.y;
  float a = hx * dx + hz * dz, s = hx * sx + hz * sz;
  float c = ${f(Math.cos(TORCH_TILT))}, n = ${f(Math.sin(TORCH_TILT))};
  float a2 = a * c + hy * n, y2 = -a * n + hy * c;
  float bx = 0.5 + w.x * 0.375, bz = 0.5 + w.y * 0.375, by = 0.1875;
  return vec3(bx + dx * a2 + sx * s, by + y2, bz + dz * a2 + sz * s);
}
CraftonVertex craftonDecode() {
  CraftonVertex v;
  uint a = data.x, b = data.y;
  uint face = a >> 29u;
  v.tile = float(b & 1023u);
  if (face == 7u) {
    vec3 cell = vec3(float(a & 15u), float((a >> 4u) & 255u), float((a >> 12u) & 15u));
    vec3 p = vec3(float((a >> 16u) & 15u), float((a >> 20u) & 15u), float((a >> 24u) & 15u)) * 0.0625;
    uint attach = (b >> 20u) & 7u;
    if (attach != 0u) p = craftonTorchWall(p, attach);
    v.pos = cell + p;
    v.uv = vec2(float((b >> 10u) & 31u), float((b >> 15u) & 31u)) * 0.0625;
    v.face = 6.0; v.ao = 3.0; v.light = vec2(1.0); v.shade = 1.0; v.topWave = 0.0; v.leaves = 0.0; v.water = 0.0;
    return v;
  }
  v.pos = vec3(float(a & 31u), float((a >> 5u) & 511u), float((a >> 14u) & 31u));
  #ifdef CRAFTON_LIQUID_Y
  v.pos.y = yf;
  #endif
  uint corner = (a >> 19u) & 3u;
  float w = float((a >> 21u) & 15u) + 1.0, h = float((a >> 25u) & 15u) + 1.0;
  bool iu = corner == 1u || corner == 2u, iv = corner >= 2u;
  if (((b >> 28u) & 1u) != 0u) v.uv = vec2(iv ? h - CRAFTON_INSET : CRAFTON_INSET, iu ? CRAFTON_INSET : w - CRAFTON_INSET);
  else v.uv = vec2(iu ? w - CRAFTON_INSET : CRAFTON_INSET, iv ? h - CRAFTON_INSET : CRAFTON_INSET);
  uint ao = (b >> 26u) & 3u;
  v.face = float(face); v.ao = float(ao);
  v.light = vec2(float((b >> 10u) & 255u), float((b >> 18u) & 255u)) * (1.0 / 240.0);
  #ifdef CRAFTON_FLAT_SHADE
  v.shade = 1.0;
  #else
  v.shade = CRAFTON_SHADE[int(face) * 4 + int(ao)];
  #endif
  v.leaves = float((b >> 29u) & 1u); v.water = float((b >> 30u) & 1u); v.topWave = float(b >> 31u);
  return v;
}`;
