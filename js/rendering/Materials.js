// Materials.js — the chunk materials (opaque, cutout, translucent, lava) plus shared helpers.
//
// the chunk passes are ShaderMaterials over the texture array (one 16×16 layer per atlas tile): a
// vertex is the packed 8-byte word pair of PackedVertex.js, decoded in the vertex shader into its position, tile-local
// coordinates that repeat with fract() across a greedy-merged quad, its tile index, shade (face brightness × AO) and
// light. The look is MeshBasicMaterial's — texel × shade × the voxel light curve, fog, sRGB output — so nothing changes
// on screen. Small block models (items, the held block) keep the plain atlas materials.

import * as THREE from 'three';
import { LIGHT_UNIFORMS } from './LightUniforms.js';
import { LIGHT_CURVE_GLSL } from '../world/lighting/LightCurve.js';
import { PACKED_VERTEX_GLSL } from './PackedVertex.js';

const CHUNK_VERTEX = `
${PACKED_VERTEX_GLSL}
varying vec2 vUv;
varying float vTile;
varying vec3 vColor;
varying vec2 vLight;
#include <fog_pars_vertex>
void main() {
  CraftonVertex cv = craftonDecode();
  vUv = cv.uv;
  vTile = cv.tile;
  vColor = vec3(cv.shade);
  vLight = cv.light;
  vec3 transformed = cv.pos;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const CHUNK_FRAGMENT = `
precision highp sampler2DArray;
uniform sampler2DArray tiles;
uniform float opacity;
uniform float alphaTest;
uniform float boost;
varying vec2 vUv;
varying float vTile;
varying vec3 vColor;
varying vec2 vLight;
#include <common>
#include <fog_pars_fragment>
${LIGHT_CURVE_GLSL}
void main() {
  vec4 texel = texture(tiles, vec3(fract(vUv), vTile));
  #ifdef CUTOUT
  if (texel.a < alphaTest) discard;
  #endif
  vec3 rgb = texel.rgb * vColor * boost;
  #ifdef VOXEL_LIGHT
  rgb *= craftonLightRGB(vLight); // max(sky curve, warm block curve)
  #endif
  gl_FragColor = vec4(rgb, texel.a * opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/**
 * The vertex-shader defines of a chunk pass: liquid passes carry the float height attribute, lava is flat-shaded (no face brightness).
 * @param {'opaque'|'cutout'|'translucent'|'lava'} pass
 */
export function chunkPassDefines(pass) {
  const d = {};
  if (pass === 'translucent' || pass === 'lava') d.CRAFTON_LIQUID_Y = '';
  if (pass === 'lava') d.CRAFTON_FLAT_SHADE = '';
  return d;
}

/**
 * One chunk pass material over the tile array. `lit` applies the Brightness light curve (everything but lava); `pass`
 * picks the vertex layout defines (chunkPassDefines).
 * @param {THREE.DataArrayTexture} tileArray
 */
export function createChunkMaterial(tileArray, key, { lit = true, cutout = false, transparent = false, opacity = 1, side = THREE.FrontSide, boost = 1, pass = 'opaque' } = {}) {
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    tiles: { value: tileArray },
    opacity: { value: opacity },
    alphaTest: { value: cutout ? 0.5 : 0 },
    boost: { value: boost },
    ...LIGHT_UNIFORMS, // the very same uniform objects: the Brightness slider applies live
  };
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: CHUNK_VERTEX,
    fragmentShader: CHUNK_FRAGMENT,
    defines: { ...(cutout ? { CUTOUT: '' } : {}), ...(lit ? { VOXEL_LIGHT: '' } : {}), ...chunkPassDefines(pass) },
    vertexColors: false, // the shade comes out of the packed vertex
    fog: true,
    transparent,
    depthWrite: !transparent,
    side,
  });
  m.name = key;
  m.customProgramCacheKey = () => 'crafton-chunk-' + key;
  return m;
}

/** @param {THREE.DataArrayTexture} tileArray the atlas as a texture array (TextureAtlas.arrayTexture) */
export function createChunkMaterials(tileArray) {
  const opaque = createChunkMaterial(tileArray, 'opaque');
  const cutout = createChunkMaterial(tileArray, 'cutout', { cutout: true, pass: 'cutout' });
  // Double-sided so the water surface is drawn from underneath (looking up from under water).
  const translucent = createChunkMaterial(tileArray, 'translucent', { transparent: true, opacity: 0.75, side: THREE.DoubleSide, pass: 'translucent' });
  // Lava: opaque-looking, self-lit (no light curve), seen from below too.
  const lava = createChunkMaterial(tileArray, 'lava', { lit: false, side: THREE.DoubleSide, pass: 'lava' });
  return { opaque, cutout, translucent, lava };
}

/** Material for small block models (item entities, held block): opaque + cutout in one via alphaTest. */
export function createBlockModelMaterial(atlasTexture, fog = true) {
  return new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog, alphaTest: 0.1, transparent: false, side: THREE.FrontSide });
}

/** Translucent variant for water/ice item models. */
export function createBlockModelMaterialTranslucent(atlasTexture, fog = true) {
  return new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog, transparent: true, opacity: 0.75, depthWrite: false });
}
