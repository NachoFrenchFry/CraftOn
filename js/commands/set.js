// set.js — /set gamemode <mode>: your own game mode (s | c | spec, or survival / creative / spectator). In multiplayer
// the host can always; a guest only with "Can change own game mode" from the host (the host validates as for every
// mode change), otherwise "You don't have permission to change your game mode."
const MODES = { s: 'survival', survival: 'survival', c: 'creative', creative: 'creative', spec: 'spectator', spectator: 'spectator' };
const NAMES = { survival: 'Survival', creative: 'Creative', spectator: 'Spectator' };

export const set = {
  name: 'set',
  description: 'sets your game mode (survival, creative, spectator)',
  syntax: [[{ kind: 'literal', value: 'gamemode' }, { kind: 'enum', name: 'mode', values: ['s', 'c', 'spec', 'survival', 'creative', 'spectator'], label: (v) => NAMES[MODES[v]] }]],
  permitted(game) { return game.isGuest && !game.net.canChangeMode ? "You don't have permission to change your game mode." : true; },
  run(game, argv, reply) {
    const mode = MODES[(argv[1] || '').toLowerCase()];
    if (!mode) { reply('Usage: /set gamemode <mode> (s, c, spec, survival, creative, spectator)', 'error'); return; }
    if (game.isGuest && !game.net.canChangeMode) { reply("You don't have permission to change your game mode.", 'error'); return; }
    if (game.player.gameMode === mode) { reply(`Game mode is already ${NAMES[mode]}`, 'info'); return; }
    game.setGameMode(mode);
    reply(`Game mode set to ${NAMES[mode]}`, 'info');
  },
};
