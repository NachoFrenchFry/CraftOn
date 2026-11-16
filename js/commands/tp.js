// tp.js — /tp <x> <y> <z> (you; "~" = your current value), /tp <player> (you to that player), and for the host only
// /tp <player> <x> <y> <z> and /tp <player> <player> (move another player). A cheat. A guest's own teleports run on the
// host (Msg.COMMAND): it validates the request, moves the guest with SPAWN_AT and resets its movement baseline, so the
// jump is never rejected as moving too fast. y is clamped to the world and a landing inside blocks is un-buried.
import { resolveCoords } from './CommandRegistry.js';

const player = (name) => ({ kind: 'player', name });
const coords = { kind: 'coords', name: 'position' };
const fmt = (p) => `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;

export const tp = {
  name: 'tp',
  description: 'teleports you, or (host) another player',
  syntax: [[coords], [player('player')], [player('player'), coords], [player('player'), player('to')]],
  cheat: true,
  remote: true,
  run(game, argv, reply, m, actor = null) {
    const form = m.form;
    const movingOther = form.length === 2;
    if (movingOther && (actor || game.isGuest)) { reply('Only the host can move other players.', 'error'); return; }
    if (!actor && game.isGuest) { game.net.sendCommand('tp', argv); return; } // the host does it for us
    const self = actor || game.selfActor();
    let who = self, dest;
    if (!movingOther) dest = form[0].kind === 'coords' ? resolveCoords(m.values[0], self) : game.playerByName(m.values[0]);
    else { who = game.playerByName(m.values[0]); dest = form[1].kind === 'coords' ? resolveCoords(m.values[1], who) : game.playerByName(m.values[1]); }
    if (!who) { reply(`${m.values[0]} is not here.`, 'error'); return; }
    if (!dest) { reply(`${form[form.length - 1].kind === 'coords' ? 'That position' : m.values[m.values.length - 1]} is not here.`, 'error'); return; }
    const r = game.teleportPlayer(who.id, dest);
    if (!r.ok) { reply(r.error || 'Could not teleport.', 'error'); return; }
    reply(`Teleported ${who.id === self.id ? 'you' : who.name} to ${fmt(r)}`, 'info');
  },
};
