// Cow.js — cow stats and box model definition. Sizes in pixels (1 px = 1/16 block), UV origins are the
// top-left corners of each box's Minecraft-style net on the 64×32 sheet textures/entity/cow.png.
// pivot = joint position in model space (x right, y up from the feet, z forward = -Z); offset = box
// center relative to the pivot. rotX rotates the box around its pivot (the body lies horizontal).

export const COW = Object.freeze({
  type: 'cow',
  displayName: 'Cow',
  texture: 'cow',
  health: 10,
  hitbox: [0.9, 1.4],
  walkSpeed: 1.1,
  panicSpeed: 2.3,
  sounds: { ambient: 'mob.cow', hurt: 'mob.cow_hurt', death: 'mob.cow_death' },
  drops: [{ item: 'raw_beef', min: 1, max: 3 }],
  parts: [
    // Body pivot y = leg top (12) + half the body depth (5): the body bottom rests exactly on the legs.
    { name: 'body', size: [12, 18, 10], uv: [18, 4], pivot: [0, 17, 2], offset: [0, 0, 0], rotX: Math.PI / 2 },
    { name: 'head', size: [8, 8, 6], uv: [0, 0], pivot: [0, 18, -8], offset: [0, 0, -3] },
    { name: 'hornL', size: [1, 3, 1], uv: [22, 0], parent: 'head', pivot: [-4.5, 3.5, -3.5], offset: [0, 0, 0] },
    { name: 'hornR', size: [1, 3, 1], uv: [22, 0], parent: 'head', pivot: [4.5, 3.5, -3.5], offset: [0, 0, 0] },
    { name: 'leg0', size: [4, 12, 4], uv: [0, 16], pivot: [-4, 12, -6], offset: [0, -6, 0] },
    { name: 'leg1', size: [4, 12, 4], uv: [0, 16], pivot: [4, 12, -6], offset: [0, -6, 0] },
    { name: 'leg2', size: [4, 12, 4], uv: [0, 16], pivot: [-4, 12, 6], offset: [0, -6, 0] },
    { name: 'leg3', size: [4, 12, 4], uv: [0, 16], pivot: [4, 12, 6], offset: [0, -6, 0] },
  ],
});
