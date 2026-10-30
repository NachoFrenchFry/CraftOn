// tick.js — /tick: the game speed on Minecraft's scale, 20 ticks per second = normal. The time scale
// (rate / 20) is applied in one place, GameLoop, so physics, animations, flowing liquids, mobs, timers, particles,
// shaders and sound all follow it; mouse look and UI fades stay real-time. Only the host may use it in multiplayer;
// guests receive the rate and the freeze state.
import { TICK_RATE_DEFAULT, TICK_RATE_MIN, TICK_RATE_MAX } from '../config/Constants.js';

const describe = (game) => `Tick rate: ${game.tick.rate} (${(game.tick.rate / TICK_RATE_DEFAULT).toFixed(game.tick.rate % TICK_RATE_DEFAULT === 0 ? 0 : 2).replace(/\.?0+$/, '')}× speed)${game.tick.frozen ? ', frozen' : ''}`;
const lit = (value) => ({ kind: 'literal', value });

export const tick = {
  name: 'tick',
  description: 'game speed (20 = normal), freeze and step',
  syntax: [
    [lit('rate'), { kind: 'int', name: 'rate', min: TICK_RATE_MIN, max: TICK_RATE_MAX, examples: ['10', '20', '40'] }],
    [lit('query')], [lit('freeze')], [lit('unfreeze')],
    [lit('step'), { kind: 'int', name: 'n', min: 1, max: 1000, optional: true, examples: ['1', '10'] }],
    [lit('reset')],
  ],
  permitted(game) { return game.isGuest ? 'Only the host can change the tick rate.' : true; },
  run(game, argv, reply, m) {
    const sub = (argv[0] || '').toLowerCase();
    if (game.isGuest) { reply('Only the host can change the tick rate.', 'error'); return; }
    switch (sub) {
      case 'rate': game.setTickRate(m.values[1]); reply(describe(game), 'info'); return;
      case 'query': reply(describe(game), 'info'); return;
      case 'freeze': game.setTickFrozen(true); reply('Game time frozen. /tick step [n] advances it, /tick unfreeze resumes.', 'info'); return;
      case 'unfreeze': game.setTickFrozen(false); reply('Game time resumed. ' + describe(game), 'info'); return;
      case 'step': {
        if (!game.tick.frozen) { reply('Game time is not frozen. Use /tick freeze first.', 'error'); return; }
        const n = m.values[1] === undefined ? 1 : m.values[1];
        game.stepTicks(n);
        reply(`Stepped ${n} tick${n === 1 ? '' : 's'}.`, 'info');
        return;
      }
      case 'reset': game.setTickFrozen(false); game.setTickRate(TICK_RATE_DEFAULT); reply(describe(game), 'info'); return;
      default: reply(`Usage: ${game.commands.usages(tick).join(' | ')}`, 'error');
    }
  },
};
