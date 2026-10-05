// Pig.js — pig stats and box model definition (see Cow.js for the field meanings).

export const PIG = Object.freeze({
  type: 'pig',
  displayName: 'Pig',
  texture: 'pig',
  health: 10,
  hitbox: [0.9, 0.9],
  walkSpeed: 1.0,
  panicSpeed: 2.2,
  sounds: { ambient: 'mob.pig', hurt: 'mob.pig_hurt', death: 'mob.pig_death' },
  drops: [{ item: 'raw_porkchop', min: 1, max: 3 }],
  parts: [
    // Body pivot y = leg top (6) + half the body depth (4).
    { name: 'body', size: [10, 16, 8], uv: [28, 8], pivot: [0, 10, 2], offset: [0, 0, 0], rotX: Math.PI / 2 },
    { name: 'head', size: [8, 8, 8], uv: [0, 0], pivot: [0, 9, -6], offset: [0, 0, -4] },
    { name: 'snout', size: [4, 3, 1], uv: [16, 16], parent: 'head', pivot: [0, -1.5, -8.5], offset: [0, 0, 0] },
    { name: 'leg0', size: [4, 6, 4], uv: [0, 16], pivot: [-3, 6, -5], offset: [0, -3, 0] },
    { name: 'leg1', size: [4, 6, 4], uv: [0, 16], pivot: [3, 6, -5], offset: [0, -3, 0] },
    { name: 'leg2', size: [4, 6, 4], uv: [0, 16], pivot: [-3, 6, 7], offset: [0, -3, 0] },
    { name: 'leg3', size: [4, 6, 4], uv: [0, 16], pivot: [3, 6, 7], offset: [0, -3, 0] },
  ],
});
