// clear.js — /clear: empties your inventory (armor included). Not a cheat; a guest's inventory is its own (synced to the host).
export const clear = {
  name: 'clear',
  description: 'empties your inventory',
  syntax: [[]],
  run(game, argv, reply) {
    const had = game.inventory.slots.filter(Boolean).length;
    game.inventory.clear();
    reply(had ? `Cleared ${had} stack${had === 1 ? '' : 's'}` : 'Your inventory is already empty', 'info');
  },
};
