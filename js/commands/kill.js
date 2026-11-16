// kill.js — /kill: kills you (the usual death screen, "Killed"; the inventory drops unless Keep inventory is on). Not a cheat.
export const kill = {
  name: 'kill',
  description: 'kills you',
  syntax: [[]],
  run(game, argv, reply) {
    if (game.player.dead) { reply('You are already dead.', 'error'); return; }
    game.health.die({ kind: 'kill' });
    reply('Killed', 'info');
  },
};
