// ArmorModel.js — builds the textured 3D armor layer (Update #7): inflated boxes with Minecraft box-UV nets
// from ArmorParts.js, hung on the body pivots so they animate with the player, alpha-tested Lambert materials
// (the same shading as the body) textured from textures/entity/armor/<material>_layer_N.png. Also the
// first-person sleeve + gauntlet boxes on the arm.

import * as THREE from 'three';
import { applyNetUVs } from '../../entities/mobs/MobModel.js';
import { ARMOR_TEXTURE_SIZE } from '../../config/TextureManifest.js';
import { PX } from './ModelParts.js';
import { ARMOR_BOXES, ARMOR_LAYER, ARMOR_SHEET_FOR, ARMOR_PIECES, FIRST_PERSON_ARMOR } from './ArmorParts.js';

const materialCache = new Map();
const hiddenMaterial = new THREE.MeshLambertMaterial({ color: 0xff00ff });

/** Shared alpha-tested material for one sheet (material 'wood' | 'iron' | 'diamond', layer 1 | 2). */
export function armorMaterial(textures, material, layer) {
  const key = `armor/${ARMOR_SHEET_FOR[material] || material}_layer_${layer}`;
  let m = materialCache.get(key);
  if (!m) {
    const map = textures ? textures.get(key) || null : null;
    m = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, transparent: false, side: THREE.FrontSide });
    if (!map) m.color.set(0xff00ff); // sheet missing: magenta, like the mobs
    materialCache.set(key, m);
  }
  return m;
}

/** One armor box (hidden until worn), positioned inside its pivot like the body part it covers. */
export function createArmorBox(box) {
  const [W, H, D] = box.size;
  const i = box.inflate;
  const geom = new THREE.BoxGeometry((W + 2 * i) * PX, (H + 2 * i) * PX, (D + 2 * i) * PX);
  applyNetUVs(geom, box.uv[0], box.uv[1], W, H, D, ARMOR_TEXTURE_SIZE[0], ARMOR_TEXTURE_SIZE[1]);
  const mesh = new THREE.Mesh(geom, hiddenMaterial);
  mesh.position.set(box.offset[0] * PX, box.offset[1] * PX, box.offset[2] * PX);
  mesh.visible = false;
  mesh.name = `armor_${box.name}`;
  mesh.userData.armorPiece = box.piece;
  return mesh;
}

const emptyPieces = () => Object.fromEntries(ARMOR_PIECES.map((p) => [p, []]));

/**
 * Build every third-person box onto the body pivots.
 * @param {{ head, body, leftArm, rightArm, leftLeg, rightLeg }} pivots THREE.Object3D per part
 * @returns {{ helmet: THREE.Mesh[], chestplate: THREE.Mesh[], gauntlets: THREE.Mesh[], leggings: THREE.Mesh[], boots: THREE.Mesh[] }}
 */
export function buildArmorLayer(pivots) {
  const out = emptyPieces();
  for (const box of ARMOR_BOXES) {
    const mesh = createArmorBox(box);
    pivots[box.part].add(mesh);
    out[box.piece].push(mesh);
  }
  return out;
}

/** First-person sleeve + gauntlet on the arm group (turned 180° about X so the fist end matches the nets). */
export function buildFirstPersonArmor(armGroup) {
  const out = emptyPieces();
  for (const box of FIRST_PERSON_ARMOR) {
    const mesh = createArmorBox(box);
    mesh.rotation.x = Math.PI;
    armGroup.add(mesh);
    out[box.piece].push(mesh);
  }
  return out;
}

/**
 * Show the worn pieces with their material's sheet, hide the rest.
 * @param {ReturnType<typeof buildArmorLayer>} pieces
 * @param {{ helmet: string|null, chestplate, gauntlets, leggings, boots }|null} worn material names
 */
export function applyWornArmor(pieces, worn, textures) {
  for (const piece of ARMOR_PIECES) {
    const material = worn && worn[piece] ? worn[piece] : null;
    for (const mesh of pieces[piece]) {
      mesh.visible = !!material;
      if (material) mesh.material = armorMaterial(textures, material, ARMOR_LAYER[piece]);
    }
  }
}
