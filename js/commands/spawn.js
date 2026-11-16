// spawn.js — /spawn: teleports you to the world spawn. A cheat. For a guest the host places it (Msg.COMMAND → SPAWN_AT with
// the baseline reset), at the world spawn the host knows.
export const spawn = {
  name: 'spawn',
  description: 'teleports you to the world spawn',
  syntax: [[]],
  cheat: true,
  remote: true,
  run(game, argv, reply, m, actor = null) {
    if (!actor && game.isGuest) { game.net.sendCommand('spawn', argv); return; }
    const who = actor || game.selfActor();
    const sp = game.player.spawn;
    const r = game.teleportPlayer(who.id, { x: sp.x, y: sp.y, z: sp.z });
    if (!r.ok) { reply(r.error || 'Could not teleport.', 'error'); return; }
    reply('Teleported you to the world spawn', 'info'); // the actor is always the one who typed it
  },
};
