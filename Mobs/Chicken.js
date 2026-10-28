// Chicken.js — chicken stats and Minecraft-style box model definition. Sizes and UVs are pixels
// (1 px = 1/16 block); UV origins are top-left corners on textures/entity/chicken.png (64×32).
// The classic chicken silhouette uses a 6×8×6 body, 4×6×3 head, 4×2×2 beak,
// 2×2×2 wattle, 1×4×6 wings, and 2×3×2 legs.

export const CHICKEN = Object.freeze({
  type: 'chicken',
  displayName: 'Chicken',
  texture: 'chicken',
  health: 4,
  hitbox: [0.4, 0.7],
  walkSpeed: 1.0,
  panicSpeed: 2.2,
  sounds: { ambient: 'mob.chicken', hurt: 'mob.chicken_hurt', death: 'mob.chicken_death' },
  drops: [{ item: 'raw_chicken', min: 1, max: 1 }, { item: 'feather', min: 0, max: 2 }],
  parts: [
    // Feet start at y=0; legs are 3 px tall, body bottom is y=3, and the head reaches y=13.
    { name: 'body', size: [6, 8, 6], uv: [0, 0], pivot: [0, 6, 0], offset: [0, 0, 0], rotX: Math.PI / 2 },
    { name: 'head', size: [4, 6, 3], uv: [24, 0], pivot: [0, 10, -3], offset: [0, 0, -1.5] },
    { name: 'beak', size: [4, 2, 2], uv: [0, 16], parent: 'head', pivot: [0, -1, -2.5], offset: [0, 0, -1] },
    { name: 'wattle', size: [2, 2, 2], uv: [12, 16], parent: 'head', pivot: [0, -3, -2], offset: [0, 0, -0.5] },
    { name: 'wingL', size: [1, 4, 6], uv: [32, 16], pivot: [-3.5, 7, 0], offset: [0, 0, 0] },
    { name: 'wingR', size: [1, 4, 6], uv: [32, 16], pivot: [3.5, 7, 0], offset: [0, 0, 0] },
    { name: 'leg0', size: [2, 3, 2], uv: [20, 16], pivot: [-1.5, 3, 1], offset: [0, -1.5, 0] },
    { name: 'leg1', size: [2, 3, 2], uv: [20, 16], pivot: [1.5, 3, 1], offset: [0, -1.5, 0] },
  ],
});
