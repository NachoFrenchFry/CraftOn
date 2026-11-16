// setspawn.js — /setspawn: moves the world spawn to where you stand (the host / single player only; every player respawns
// there from now on). A cheat.
export const setspawn = {
  name: 'setspawn',
  description: 'moves the world spawn to where you stand (host)',
  syntax: [[]],
  cheat: true,
  permitted(game) { return game.isGuest ? 'Only the host can move the world spawn.' : true; },
  run(game, argv, reply) {
    if (game.isGuest) { reply('Only the host can move the world spawn.', 'error'); return; }
    const p = game.setWorldSpawn(game.player.position);
    reply(`World spawn set to ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`, 'info');
  },
};
