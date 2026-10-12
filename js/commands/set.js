// set.js — /set gamemode <s|c|spec>: your own game mode (also survival / creative / spectator). In multiplayer the
// host can always; a guest only with "Can change own game mode" from the host (the host validates as for every
// mode change), otherwise "You don't have permission to change your game mode."
const MODES = { s: 'survival', survival: 'survival', c: 'creative', creative: 'creative', spec: 'spectator', spectator: 'spectator' };
const NAMES = { survival: 'Survival', creative: 'Creative', spectator: 'Spectator' };

export const set = {
  name: 'set',
  usage: '/set gamemode <s|c|spec>',
  description: 'sets your game mode (survival, creative, spectator)',
  run(game, argv, reply) {
    const what = (argv[0] || '').toLowerCase();
    if (what !== 'gamemode') { reply('Usage: /set gamemode <s|c|spec>', 'error'); return; }
    const mode = MODES[(argv[1] || '').toLowerCase()];
    if (!mode) { reply('Usage: /set gamemode <s|c|spec> (survival, creative, spectator)', 'error'); return; }
    if (game.isGuest && !game.net.canChangeMode) { reply("You don't have permission to change your game mode.", 'error'); return; }
    if (game.player.gameMode === mode) { reply(`Game mode is already ${NAMES[mode]}`, 'info'); return; }
    game.setGameMode(mode);
    reply(`Game mode set to ${NAMES[mode]}`, 'info');
  },
  complete(game, argv) {
    if (argv.length <= 1) return ['gamemode'];
    if (argv.length === 2) return ['survival', 'creative', 'spectator', 's', 'c', 'spec'];
    return [];
  },
};
