// LavaSounds.js — lava (Update #11): the sizzle when lava meets water or burns an item (a hiss with a few pops),
// the bubbling pop of a lava pool and the crackle of a player on fire.
import { noiseBurst, tone, click } from '../SoundSynth.js';

export function registerLavaSounds(bank) {
  bank.define('lava.sizzle', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.01, hold: 0.12, decay: 0.55, gain: 0.5, filter: { type: 'bandpass', freq: 3200 * (1 + (rng.next() - 0.5) * 0.3), freqEnd: 1500, Q: 0.9 } });
    noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.05, decay: 0.4, gain: 0.25, start: 0.05, filter: { type: 'highpass', freq: 1800, Q: 0.7 } });
    const n = 3 + rng.nextInt(4);
    for (let i = 0; i < n; i++) click(ctx, dest, rng, { gain: 0.18, start: 0.05 + rng.next() * 0.45 });
  }, 0.8);
  bank.define('lava.pop', (ctx, dest, rng) => {
    const f = 160 * (1 + (rng.next() - 0.5) * 0.4);
    tone(ctx, dest, { type: 'sine', freq: f, freqEnd: f * 0.5, attack: 0.004, decay: 0.16, gain: 0.35 });
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.004, decay: 0.12, gain: 0.3, filter: { type: 'lowpass', freq: 500, Q: 0.8 } });
  }, 0.6);
  bank.define('player.burn', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.02, decay: 0.5, gain: 0.3, filter: { type: 'bandpass', freq: 2400, Q: 1.2 }, gate: { rate: 18 + rng.next() * 10, depth: 0.7 } });
    for (let i = 0; i < 4; i++) click(ctx, dest, rng, { gain: 0.15, start: rng.next() * 0.45 });
  }, 0.4);
}
