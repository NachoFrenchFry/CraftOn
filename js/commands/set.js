// set.js — /set gamemode <mode>: your own game mode (s | c | spec, or survival / creative / spectator). In multiplayer
// the host can always; a guest only with the host's cheats permission ("Can use cheats (game mode and commands)"; the
// host validates as for every mode change), otherwise "You don't have permission to change your game mode." Leaving
// Survival is a cheat (Nov 11 2026): the Pure Survival badge asks first (the registry's "type it again" flow); a locked
// world refuses every mode change with "This world is locked to <Mode>".
import { lockedText } from '../core/WorldSettings.js';

const MODES = { s: 'survival', survival: 'survival', c: 'creative', creative: 'creative', spec: 'spectator', spectator: 'spectator' };
const NAMES = { survival: 'Survival', creative: 'Creative', spectator: 'Spectator' };

export const set = {
  name: 'set',
  description: 'sets your game mode (survival, creative, spectator)',
  syntax: [[{ kind: 'literal', value: 'gamemode' }, { kind: 'enum', name: 'mode', values: ['s', 'c', 'spec', 'survival', 'creative', 'spectator'], label: (v) => NAMES[MODES[v]] }]],
  /** Only leaving Survival counts as a cheat. */
  cheat: (game, m) => MODES[String(m && m.values ? m.values[1] : '').toLowerCase()] !== 'survival',
  permitted(game) {
    if (game.lockedMode) return lockedText(game.lockedMode);
    return game.isGuest && !game.net.canChangeMode ? "You don't have permission to change your game mode." : true;
  },
  run(game, argv, reply) {
    const mode = MODES[(argv[1] || '').toLowerCase()];
    if (!mode) { reply('Usage: /set gamemode <mode> (s, c, spec, survival, creative, spectator)', 'error'); return; }
    if (game.lockedMode) { reply(lockedText(game.lockedMode), 'error'); return; }
    if (game.isGuest && !game.net.canChangeMode) { reply("You don't have permission to change your game mode.", 'error'); return; }
    if (game.player.gameMode === mode) { reply(`Game mode is already ${NAMES[mode]}`, 'info'); return; }
    // The badge was handled by the registry (a cheat): no second question here.
    const r = game.requestGameMode(mode, { confirm: false });
    const done = (ok) => { if (ok) reply(`Game mode set to ${NAMES[mode]}`, 'info'); };
    if (r && typeof r.then === 'function') r.then(done); else done(r);
  },
};
