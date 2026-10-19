// ModelParts.js — box parts with pivot groups for the character models: flat-colour parts (the first-person fallbacks)
// and skin-textured parts whose UVs follow the 64×64 Minecraft skin layout (SkinLayout.js) through the mobs' box-UV net.

import * as THREE from 'three';
import { applyNetUVs } from '../../entities/mobs/MobModel.js';
import { SKIN_SIZE } from './SkinLayout.js';

/** One model pixel in world units (32 px tall model = 1.8 blocks). */
export const PX = 1.8 / 32;

/**
 * Held tools: the item sprite is a flat extrusion whose handle runs along its diagonal. A 45° roll
 * stands the handle up (+Y of the handle group); this extra turn about that handle axis puts the sprite
 * plane into the swing plane, so the pickaxe point, the axe blade and the sword edge face -Z — the
 * direction the head travels during a swing — instead of the flat side.
 */
export const TOOL_EDGE_TURN = Math.PI / 2 + 10 * Math.PI / 180; // 100°: the edge turn plus 10° the other way
/**
 * The turn actually applied about the handle: TOOL_EDGE_TURN − π (about −80°). The plain 100° turn left the sprite's
 * back (−Z) face toward the camera, so held tools looked left-right mirrored against their hotbar icons (an axe head
 * on the wrong side); turning 180° further about the same axis shows the front (+Z) face, so the texture reads like
 * the icon. The sprite plane stays in the swing plane.
 */
export const TOOL_HANDLE_TURN = TOOL_EDGE_TURN - Math.PI;
/** Euler for a tool handle group inside a swing pivot: roll first (diagonal → +Y), then the turn about the handle. */
export function setToolHandleRotation(group) { group.rotation.set(0, TOOL_HANDLE_TURN, Math.PI / 4, 'XYZ'); return group; }

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

const skinMaterials = new Map();
/** The alpha-tested Lambert material of one skin sheet (shared; tintModelLight clones it per model, hurtVariant per flash). */
export function skinMaterial(texture) {
  let m = skinMaterials.get(texture);
  if (!m) { m = new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.5, transparent: false, side: THREE.FrontSide }); if (!texture) m.color.set(0xff00ff); skinMaterials.set(texture, m); }
  return m;
}

const skinGeometries = new Map();
/** A box geometry with the skin layout's net for `part` (SkinLayout.js), inflated by `inflate` pixels; cached per part + inflate. */
export function skinGeometry(part, inflate = 0) {
  const key = `${part.name}:${inflate}`;
  let geom = skinGeometries.get(key);
  if (!geom) {
    const [W, H, D] = part.size;
    geom = new THREE.BoxGeometry((W + 2 * inflate) * PX, (H + 2 * inflate) * PX, (D + 2 * inflate) * PX);
    applyNetUVs(geom, part.uv[0], part.uv[1], W, H, D, SKIN_SIZE[0], SKIN_SIZE[1]);
    skinGeometries.set(key, geom);
  }
  return geom;
}

/**
 * A skin-textured part from the layout table: the box with its net UVs inside a pivot group at the part's offset.
 * `texture` is the 64×64 skin (textures/entity/player.png or a mob's); null paints it magenta like a missing mob sheet.
 */
export function createSkinPart(part, texture, inflate = 0) {
  const mesh = new THREE.Mesh(skinGeometry(part, inflate), skinMaterial(texture));
  mesh.position.set(part.offset[0] * PX, part.offset[1] * PX, part.offset[2] * PX);
  mesh.name = part.name;
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
 * Voxel lighting for a character model: every part gets its own material clone (lazily, once) whose
 * colour is the base colour × the brightness factor of the sky light at the model. Meshes swapped to a hurt
 * variant (userData.baseMaterial set) are left alone until the flash ends.
 */
export function tintModelLight(owner, root, factor) {
  const rgb = typeof factor !== 'number';
  root.traverse((o) => {
    if (!o.isMesh || !o.material || o.userData.baseMaterial) return;
    let m = o.material;
    if (ownerOf.get(m) !== owner) { m = m.clone(); ownerOf.set(m, owner); baseColorOf.set(m, m.color.clone()); o.material = m; }
    const c = m.color.copy(baseColorOf.get(m));
    if (rgb) { c.r *= factor[0]; c.g *= factor[1]; c.b *= factor[2]; } else c.multiplyScalar(factor); // [r, g, b]: sky + warm block light
  });
}
