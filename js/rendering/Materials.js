// Materials.js — the three chunk materials (opaque, cutout, translucent) plus shared helpers.

import * as THREE from 'three';
import { LIGHT_UNIFORMS } from './LightUniforms.js';
import { LIGHT_CURVE_GLSL } from '../world/lighting/LightCurve.js';

/**
 * Voxel lighting with shaders off (Update #10): the vertex colour keeps the baked face shade × AO and the mesher's
 * smoothed sky light arrives as the `light` attribute (0–240 = level × 16); the fragment multiplies by the
 * Minecraft-like brightness curve with the Brightness option's uniforms, so the slider applies live without re-baking.
 */
function withVoxelLight(material, key) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, LIGHT_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 light;\nvarying vec2 vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = light / 240.0;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLight;' + LIGHT_CURVE_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= craftonLightRGB(vLight);'); // max(sky curve, warm block curve), Update #11
  };
  material.customProgramCacheKey = () => 'crafton-voxel-light-' + key;
  return material;
}

export function createChunkMaterials(atlasTexture) {
  const opaque = withVoxelLight(new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog: true, side: THREE.FrontSide }), 'opaque');
  const cutout = withVoxelLight(new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog: true, alphaTest: 0.5, transparent: false, side: THREE.FrontSide }), 'cutout');
  // Double-sided so the water surface is drawn from underneath (looking up from under water).
  const translucent = withVoxelLight(new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog: true, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }), 'translucent');
  // Lava (Update #11): opaque-looking, self-lit (no light curve), seen from below too.
  const lava = new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog: true, side: THREE.DoubleSide });
  lava.name = 'lava';
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
