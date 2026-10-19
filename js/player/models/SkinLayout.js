// SkinLayout.js — the 64×64 Minecraft skin layout (classic 4-px-wide arms) as pure data: the box of every body part with
// its pixel size, the top-left corner of its box-UV net on the sheet (MobNet.js), its pivot (joint, pixels up from the feet;
// x right, z forward = −Z) and the box centre relative to the pivot. Shared by the player model (PlayerModel.js), the
// first-person arm, the zombie definition (entities/mobs/Zombie.js), the skin painters in tools/texture-recipes/ and the
// Node checks, so repainting textures/entity/player.png follows this one table (README → Player skin).

export const SKIN_SIZE = Object.freeze([64, 64]);

/** The six body boxes. Arm pivots sit 1 px below the shoulder top, like the flat-colour model always did. */
export const SKIN_PARTS = Object.freeze([
  { name: 'head', size: [8, 8, 8], uv: [0, 0], pivot: [0, 24, 0], offset: [0, 4, 0] },
  { name: 'body', size: [8, 12, 4], uv: [16, 16], pivot: [0, 12, 0], offset: [0, 6, 0] },
  { name: 'rightArm', size: [4, 12, 4], uv: [40, 16], pivot: [6, 23, 0], offset: [0, -6, 0] },
  { name: 'leftArm', size: [4, 12, 4], uv: [32, 48], pivot: [-6, 23, 0], offset: [0, -6, 0] },
  { name: 'rightLeg', size: [4, 12, 4], uv: [0, 16], pivot: [2, 12, 0], offset: [0, -6, 0] },
  { name: 'leftLeg', size: [4, 12, 4], uv: [16, 48], pivot: [-2, 12, 0], offset: [0, -6, 0] },
]);

/** The optional hat layer: the head again, inflated half a pixel, from the second head net. Transparent on the default skin. */
export const SKIN_HAT = Object.freeze({ name: 'hat', size: [8, 8, 8], uv: [32, 0], pivot: [0, 24, 0], offset: [0, 4, 0], inflate: 0.5, parent: 'head' });

export const SKIN_PART_BY_NAME = Object.freeze(Object.fromEntries(SKIN_PARTS.map((p) => [p.name, p])));
