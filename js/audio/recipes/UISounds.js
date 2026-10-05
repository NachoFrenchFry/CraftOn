// UISounds.js — click, hover tick, inventory open/close, item pickup pop and item drop whoosh.

import { noiseBurst, tone, click } from '../SoundSynth.js';

export function registerUISounds(bank) {
  bank.define('ui.click', (ctx, dest, rng) => {
    click(ctx, dest, rng, { gain: 0.5 });
    tone(ctx, dest, { type: 'square', freq: 900, attack: 0.001, decay: 0.03, gain: 0.12 });
  }, 0.08);
  bank.define('ui.hover', (ctx, dest, rng) => {
    click(ctx, dest, rng, { gain: 0.12, duration: 0.003 });
  }, 0.03);
  bank.define('ui.inv_open', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.01, decay: 0.09, gain: 0.35, filter: { type: 'bandpass', freq: 600, freqEnd: 2400, Q: 1.5 } });
  }, 0.15);
  bank.define('ui.inv_close', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.01, decay: 0.09, gain: 0.35, filter: { type: 'bandpass', freq: 2400, freqEnd: 600, Q: 1.5 } });
  }, 0.15);
  bank.define('ui.pop', (ctx, dest, rng) => {
    const f = 600 * (1 + (rng.next() - 0.5) * 0.3);
    tone(ctx, dest, { type: 'sine', freq: f, freqEnd: f * 2, attack: 0.003, decay: 0.07, gain: 0.35 });
  }, 0.12);
  bank.define('ui.craft', (ctx, dest, rng) => {
    // Wooden knock + a bright click: something was assembled.
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.002, decay: 0.09, gain: 0.4, filter: { type: 'bandpass', freq: 420 * (1 + (rng.next() - 0.5) * 0.2), Q: 9 } });
    tone(ctx, dest, { type: 'triangle', freq: 260, freqEnd: 190, attack: 0.002, decay: 0.08, gain: 0.25 });
    click(ctx, dest, rng, { gain: 0.3, start: 0.06 });
    tone(ctx, dest, { type: 'square', freq: 1200, attack: 0.001, decay: 0.03, gain: 0.08, start: 0.06 });
  }, 0.25);
  bank.define('ui.smelt', (ctx, dest, rng) => {
    // Fwoosh: a bandpass sweep upward, then a short crackling sizzle.
    noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.03, hold: 0.05, decay: 0.25, gain: 0.45, filter: { type: 'bandpass', freq: 300, freqEnd: 2600, Q: 1.1 } });
    for (let i = 0; i < 7; i++) click(ctx, dest, rng, { gain: 0.15, start: 0.12 + rng.next() * 0.3, duration: 0.004 });
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.05, decay: 0.3, gain: 0.12, start: 0.15, filter: { type: 'highpass', freq: 3500, Q: 0.7 } });
  }, 0.55);
  bank.define('ui.drop', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.02, decay: 0.15, gain: 0.3, filter: { type: 'bandpass', freq: 300, freqEnd: 900, Q: 1.2 } });
  }, 0.25);
}
