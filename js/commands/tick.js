// tick.js — /tick (Update #12): the game speed on Minecraft's scale, 20 ticks per second = normal. The time scale
// (rate / 20) is applied in one place, GameLoop, so physics, animations, flowing liquids, mobs, timers, particles,
// shaders and sound all follow it; mouse look and UI fades stay real-time. Only the host may use it in multiplayer;
// guests receive the rate and the freeze state.
import { TICK_RATE_DEFAULT, TICK_RATE_MIN, TICK_RATE_MAX } from '../config/Constants.js';

const SUBCOMMANDS = ['rate', 'query', 'freeze', 'unfreeze', 'step', 'reset'];
const describe = (game) => `Tick rate: ${game.tick.rate} (${(game.tick.rate / TICK_RATE_DEFAULT).toFixed(game.tick.rate % TICK_RATE_DEFAULT === 0 ? 0 : 2).replace(/\.?0+$/, '')}× speed)${game.tick.frozen ? ', frozen' : ''}`;

export const tick = {
  name: 'tick',
  usage: '/tick rate <1-100> | query | freeze | unfreeze | step [n] | reset',
  description: 'game speed (20 = normal), freeze and step',
  run(game, argv, reply) {
    const sub = (argv[0] || '').toLowerCase();
    if (!SUBCOMMANDS.includes(sub)) { reply(`Usage: ${tick.usage}`, 'error'); return; }
    if (game.isGuest) { reply('Only the host can change the tick rate.', 'error'); return; }
    switch (sub) {
      case 'rate': {
        const n = Number(argv[1]);
        if (!Number.isFinite(n) || n < TICK_RATE_MIN || n > TICK_RATE_MAX || argv[1] === undefined) { reply(`Usage: /tick rate <${TICK_RATE_MIN}-${TICK_RATE_MAX}>`, 'error'); return; }
        game.setTickRate(Math.round(n));
        reply(describe(game), 'info');
        return;
      }
      case 'query': reply(describe(game), 'info'); return;
      case 'freeze': game.setTickFrozen(true); reply('Game time frozen. /tick step [n] advances it, /tick unfreeze resumes.', 'info'); return;
      case 'unfreeze': game.setTickFrozen(false); reply('Game time resumed. ' + describe(game), 'info'); return;
      case 'step': {
        if (!game.tick.frozen) { reply('Game time is not frozen. Use /tick freeze first.', 'error'); return; }
        const n = argv[1] === undefined ? 1 : Number(argv[1]);
        if (!Number.isFinite(n) || n < 1 || n > 1000) { reply('Usage: /tick step [1-1000]', 'error'); return; }
        game.stepTicks(Math.round(n));
        reply(`Stepped ${Math.round(n)} tick${n === 1 ? '' : 's'}.`, 'info');
        return;
      }
      case 'reset': game.setTickFrozen(false); game.setTickRate(TICK_RATE_DEFAULT); reply(describe(game), 'info'); return;
      default: return;
    }
  },
  complete(game, argv) {
    if (argv.length <= 1) return SUBCOMMANDS;
    if (argv.length === 2 && (argv[0] || '').toLowerCase() === 'rate') return ['10', '20', '40'];
    return [];
  },
};
