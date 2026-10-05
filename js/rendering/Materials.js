// Materials.js — the three chunk materials (opaque, cutout, translucent) plus shared helpers.

import * as THREE from 'three';

export function createChunkMaterials(atlasTexture) {
  const opaque = new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog: true, side: THREE.FrontSide });
  const cutout = new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog: true, alphaTest: 0.5, transparent: false, side: THREE.FrontSide });
  // Double-sided so the water surface is drawn from underneath (looking up from under water).
  const translucent = new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog: true, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
  return { opaque, cutout, translucent };
}

/** Material for small block models (item entities, held block): opaque + cutout in one via alphaTest. */
export function createBlockModelMaterial(atlasTexture, fog = true) {
  return new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog, alphaTest: 0.1, transparent: false, side: THREE.FrontSide });
}

/** Translucent variant for water/ice item models. */
export function createBlockModelMaterialTranslucent(atlasTexture, fog = true) {
  return new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, fog, transparent: true, opacity: 0.75, depthWrite: false });
}
