// summon.js — /summon <mob> [count]: the mob where you stand (count 1–20; zombies need Hostile mobs on). A cheat. For a
// guest the host spawns them at the guest's position (Msg.COMMAND), so every player sees them.
export const summon = {
  name: 'summon',
  description: 'spawns a mob where you stand',
  syntax: [[{ kind: 'mob', name: 'mob' }, { kind: 'int', name: 'count', min: 1, max: 20, optional: true, examples: ['1', '5'] }]],
  cheat: true,
  remote: true,
  run(game, argv, reply, m, actor = null) {
    if (!actor && game.isGuest) { game.net.sendCommand('summon', argv); return; }
    const type = m.values[0], count = m.values[1] === undefined ? 1 : m.values[1];
    const who = actor || game.selfActor();
    const r = game.summonMobs(type, count, who);
    if (r.error) { reply(r.error, 'error'); return; }
    reply(`Summoned ${r.spawned} × ${game.mobLabel(type)}`, 'info');
  },
};
