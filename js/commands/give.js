// give.js — /give <item> [count]: the item into your inventory (count 1–640, default 1; what does not fit drops at your
// feet). A cheat. For a guest the host grants it (Msg.COMMAND → the existing ITEM_GRANT).
export const give = {
  name: 'give',
  description: 'puts an item in your inventory',
  syntax: [[{ kind: 'item', name: 'item' }, { kind: 'int', name: 'count', min: 1, max: 640, optional: true, examples: ['1', '16', '64'] }]],
  cheat: true,
  remote: true,
  run(game, argv, reply, m, actor = null) {
    if (!actor && game.isGuest) { game.net.sendCommand('give', argv); return; }
    const name = m.values[0], count = m.values[1] === undefined ? 1 : m.values[1];
    const who = actor || game.selfActor();
    const n = game.giveItem(who.id, name, count);
    if (!n) { reply(`Could not give ${name}.`, 'error'); return; }
    reply(`Gave ${n} × ${game.itemLabel(name)}`, 'info'); // the actor is always the one who typed it
  },
};
