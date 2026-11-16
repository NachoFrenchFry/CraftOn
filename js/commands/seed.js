// seed.js — /seed: the world seed (the text it was typed as when there is one) as a click-to-copy chat segment. Not a cheat.
export const seed = {
  name: 'seed',
  description: 'shows the world seed (click to copy)',
  syntax: [[]],
  run(game, argv, reply) {
    const meta = game.worldMeta || {};
    const shown = meta.seedText ? String(meta.seedText) : String(meta.seed ?? game.world.seed);
    reply([{ text: 'Seed: ' }, { text: shown, bold: true, copy: shown }], 'info');
  },
};
