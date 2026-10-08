// ModelParts.js — box parts with pivot groups for the character models. Flat colors, no skin texture.

import * as THREE from 'three';

/** One model pixel in world units (32 px tall model = 1.8 blocks). */
export const PX = 1.8 / 32;

/**
 * Held tools (Update #8): the item sprite is a flat extrusion whose handle runs along its diagonal. A 45° roll
 * stands the handle up (+Y of the handle group); this extra turn about that handle axis puts the sprite
 * plane into the swing plane, so the pickaxe point, the axe blade and the sword edge face -Z — the
 * direction the head travels during a swing — instead of the flat side.
 */
export const TOOL_EDGE_TURN = Math.PI / 2 + 10 * Math.PI / 180; // 100°: the Update #8 edge turn plus 10° the other way (Update #9 follow-up)
/** Euler for a tool handle group inside a swing pivot: roll first (diagonal → +Y), then the edge turn. */
export function setToolHandleRotation(group) { group.rotation.set(0, TOOL_EDGE_TURN, Math.PI / 4, 'XYZ'); return group; }

export const COLORS = Object.freeze({
  skin: 0xc69c6d,
  hair: 0x3b2a1a,
  shirt: 0x2fa8a8,
  pants: 0x3a3aa0,
  shoes: 0x3a3a3a,
  eyeWhite: 0xf4f4f4,
  pupil: 0x23233a,
});

const materialCache = new Map();
export function partMaterial(color) {
  let m = materialCache.get(color);
  if (!m) { m = new THREE.MeshLambertMaterial({ color }); materialCache.set(color, m); }
  return m;
}

/**
 * Create a box part (sizes in model pixels). The mesh is offset by `offset` (pixels) inside a pivot
 * group so rotations happen around the joint. Returns { pivot, mesh }.
 */
export function createPart(w, h, d, color, offset = [0, 0, 0]) {
  const geom = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  const mesh = new THREE.Mesh(geom, partMaterial(color));
  mesh.position.set(offset[0] * PX, offset[1] * PX, offset[2] * PX);
  const pivot = new THREE.Group();
  pivot.add(mesh);
  return { pivot, mesh };
}

/** Lights that affect only the Lambert character materials (chunks use MeshBasicMaterial). */
export function createModelLights() {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a5a, 1.1);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(0.5, 1, 0.3);
  return [hemi, dir];
}

const ownerOf = new WeakMap();   // material → model that owns the clone
const baseColorOf = new WeakMap();
/**
 * Voxel lighting for a character model (Update #10): every part gets its own material clone (lazily, once) whose
 * colour is the base colour × the brightness factor of the sky light at the model. Meshes swapped to a hurt
 * variant (userData.baseMaterial set) are left alone until the flash ends.
 */
export function tintModelLight(owner, root, factor) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material || o.userData.baseMaterial) return;
    let m = o.material;
    if (ownerOf.get(m) !== owner) { m = m.clone(); ownerOf.set(m, owner); baseColorOf.set(m, m.color.clone()); o.material = m; }
    m.color.copy(baseColorOf.get(m)).multiplyScalar(factor);
  });
}
