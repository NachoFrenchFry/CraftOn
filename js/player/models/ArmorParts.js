// ArmorParts.js — the armor layer as pure data (no Three.js), shared by the model builder (ArmorModel.js), the
// sheet painter (tools/texture-recipes/ArmorTextures.js) and the Node check (tools/check-armor.mjs), the way
// MobNet.js is shared by the mobs. Every piece is one or more boxes slightly larger than the body part it
// covers ("inflate", in model pixels) that share the part's pivot, so they animate with the body. UVs are
// Minecraft box-UV nets on 64×32 sheets: layer 1 = helmet, chestplate (+ sleeves), gauntlets, boots;
// layer 2 = leggings (waist + upper legs). Faces that should not cover anything are listed in OPEN_FACES and
// painted transparent (alpha test).

import { netRects } from '../../entities/mobs/MobNet.js';

/** Item material → sheet file prefix (textures/entity/armor/<prefix>_layer_N.png). */
export const ARMOR_SHEET_FOR = Object.freeze({ wood: 'wooden', gold: 'golden', iron: 'iron', diamond: 'diamond' });
export const ARMOR_LAYER = Object.freeze({ helmet: 1, chestplate: 1, gauntlets: 1, boots: 1, leggings: 2 });
export const ARMOR_PIECES = Object.freeze(['helmet', 'chestplate', 'gauntlets', 'leggings', 'boots']);

/**
 * Third-person boxes. `part` is the PlayerModel pivot the box hangs from; `offset` is the box centre in model
 * pixels inside that pivot (the same numbers the body parts use); `size` is the covered part's size and
 * `inflate` grows the box on every side.
 */
export const ARMOR_BOXES = Object.freeze([
  { piece: 'helmet', name: 'helmet', part: 'head', size: [8, 8, 8], uv: [0, 0], inflate: 1.0, offset: [0, 4, 0] },
  { piece: 'chestplate', name: 'chest', part: 'body', size: [8, 12, 4], uv: [16, 16], inflate: 1.0, offset: [0, 6, 0] },
  { piece: 'chestplate', name: 'sleeve', part: 'leftArm', size: [4, 6, 4], uv: [40, 16], inflate: 1.0, offset: [0, -3, 0] },
  { piece: 'chestplate', name: 'sleeve', part: 'rightArm', size: [4, 6, 4], uv: [40, 16], inflate: 1.0, offset: [0, -3, 0] },
  { piece: 'gauntlets', name: 'gauntlet', part: 'leftArm', size: [4, 6, 4], uv: [32, 0], inflate: 0.75, offset: [0, -9, 0] },
  { piece: 'gauntlets', name: 'gauntlet', part: 'rightArm', size: [4, 6, 4], uv: [32, 0], inflate: 0.75, offset: [0, -9, 0] },
  { piece: 'boots', name: 'boot', part: 'leftLeg', size: [4, 5, 4], uv: [48, 0], inflate: 1.0, offset: [0, -9.5, 0] },
  { piece: 'boots', name: 'boot', part: 'rightLeg', size: [4, 5, 4], uv: [48, 0], inflate: 1.0, offset: [0, -9.5, 0] },
  { piece: 'leggings', name: 'waist', part: 'body', size: [8, 5, 4], uv: [16, 16], inflate: 0.5, offset: [0, 2.5, 0] },
  { piece: 'leggings', name: 'legging', part: 'leftLeg', size: [4, 7, 4], uv: [0, 16], inflate: 0.5, offset: [0, -3.5, 0] },
  { piece: 'leggings', name: 'legging', part: 'rightLeg', size: [4, 7, 4], uv: [0, 16], inflate: 0.5, offset: [0, -3.5, 0] },
]);

/**
 * First-person arm boxes (the arm's local +Y runs from the shoulder to the fist). They reuse the sleeve and
 * gauntlet nets; the builder turns them 180° about X so the net's "bottom" (the fist end in third person) is
 * still the fist end here.
 */
export const FIRST_PERSON_ARMOR = Object.freeze([
  { piece: 'chestplate', name: 'sleeve', size: [4, 8, 4], uv: [40, 16], inflate: 1.0, offset: [0, 4, 0] },
  { piece: 'gauntlets', name: 'gauntlet', size: [4, 4.4, 4], uv: [32, 0], inflate: 0.75, offset: [0, 10.2, 0] },
]);

/** Faces painted transparent because they would cover nothing (joints, the neck opening, open leg ends). */
export const OPEN_FACES = Object.freeze({
  helmet: ['bottom'],
  chest: [],
  sleeve: ['bottom'],
  gauntlet: ['top'],
  boot: ['top'],
  waist: ['top', 'bottom'],
  legging: ['top', 'bottom'],
});

export function layerBoxes(layer) { return ARMOR_BOXES.filter((b) => ARMOR_LAYER[b.piece] === layer); }

/** Distinct nets of a layer (left / right boxes share one): [{ piece, name, uv, size, rects }]. */
export function layerNets(layer) {
  const seen = new Map();
  for (const b of layerBoxes(layer)) {
    const key = `${b.uv[0]},${b.uv[1]},${b.size.join('x')}`;
    if (!seen.has(key)) seen.set(key, { piece: b.piece, name: b.name, uv: b.uv, size: b.size, rects: netRects(b.uv[0], b.uv[1], b.size[0], b.size[1], b.size[2]) });
  }
  return [...seen.values()];
}

/** A MobNet.checkNets-compatible definition for one layer. */
export function layerDefinition(layer) {
  return { type: `armor layer ${layer}`, parts: layerBoxes(layer).map((b) => ({ name: b.name, uv: b.uv, size: b.size })) };
}
