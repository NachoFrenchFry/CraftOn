// Sheep.js — sheep stats and box model definition (see Cow.js). The wool layer uses the second sheet
// textures/entity/sheep_wool.png with the same UV layout but inflated boxes.

export const SHEEP = Object.freeze({
  type: 'sheep',
  displayName: 'Sheep',
  texture: 'sheep',
  woolTexture: 'sheep_wool',
  health: 8,
  hitbox: [0.9, 1.3],
  walkSpeed: 1.0,
  panicSpeed: 2.2,
  sounds: { ambient: 'mob.sheep', hurt: 'mob.sheep_hurt', death: 'mob.sheep_death' },
  drops: [{ item: 'raw_mutton', min: 1, max: 2 }, { item: 'wool_white', min: 1, max: 1 }],
  parts: [
    // Body pivot y = leg top (12) + half the body depth (3).
    { name: 'body', size: [8, 16, 6], uv: [28, 8], pivot: [0, 15, 2], offset: [0, 0, 0], rotX: Math.PI / 2 },
    { name: 'head', size: [6, 6, 8], uv: [0, 0], pivot: [0, 14, -8], offset: [0, 1, -2] },
    { name: 'leg0', size: [4, 12, 4], uv: [0, 16], pivot: [-3, 12, -5], offset: [0, -6, 0] },
    { name: 'leg1', size: [4, 12, 4], uv: [0, 16], pivot: [3, 12, -5], offset: [0, -6, 0] },
    { name: 'leg2', size: [4, 12, 4], uv: [0, 16], pivot: [-3, 12, 7], offset: [0, -6, 0] },
    { name: 'leg3', size: [4, 12, 4], uv: [0, 16], pivot: [3, 12, 7], offset: [0, -6, 0] },
    // Wool layer (same UV origins on sheep_wool.png, inflated).
    { name: 'woolBody', size: [8, 16, 6], uv: [28, 8], pivot: [0, 15, 2], offset: [0, 0, 0], rotX: Math.PI / 2, inflate: 1.75, layer: 'wool' },
    { name: 'woolHead', size: [6, 6, 8], uv: [0, 0], parent: 'head', pivot: [0, 0, 0], offset: [0, 1, -2], inflate: 0.6, layer: 'wool' },
    { name: 'woolLeg0', size: [4, 6, 4], uv: [0, 16], parent: 'leg0', pivot: [0, 0, 0], offset: [0, -3, 0], inflate: 0.5, layer: 'wool' },
    { name: 'woolLeg1', size: [4, 6, 4], uv: [0, 16], parent: 'leg1', pivot: [0, 0, 0], offset: [0, -3, 0], inflate: 0.5, layer: 'wool' },
    { name: 'woolLeg2', size: [4, 6, 4], uv: [0, 16], parent: 'leg2', pivot: [0, 0, 0], offset: [0, -3, 0], inflate: 0.5, layer: 'wool' },
    { name: 'woolLeg3', size: [4, 6, 4], uv: [0, 16], parent: 'leg3', pivot: [0, 0, 0], offset: [0, -3, 0], inflate: 0.5, layer: 'wool' },
  ],
});
