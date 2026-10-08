// PlayerSounds.js — jump, land, splash and swim sounds.

import { noiseBurst, tone, click, ping } from '../SoundSynth.js';
import { splash } from './BlockSounds.js';

export function registerPlayerSounds(bank) {
  bank.define('player.jump', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.004, decay: 0.07, gain: 0.25, filter: { type: 'lowpass', freq: 900, Q: 0.7 } });
  }, 0.15);
  bank.define('player.land', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.003, decay: 0.14, gain: 0.5, filter: { type: 'lowpass', freq: 700, Q: 0.8 }, gate: { rate: 30, depth: 0.5 } });
    tone(ctx, dest, { type: 'sine', freq: 90, freqEnd: 60, attack: 0.002, decay: 0.08, gain: 0.3 });
  }, 0.3);
  bank.define('player.splash', (ctx, dest, rng) => splash(ctx, dest, rng, 0.6, 1.2), 0.9);
  // Buckets: filling is a bubbly upward sweep; emptying is a splash.
  bank.define('player.bucket_fill', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.02, decay: 0.3, gain: 0.3, filter: { type: 'bandpass', freq: 500, freqEnd: 2500, Q: 1.5 } });
    for (let i = 0; i < 5; i++) { const f = 300 + rng.next() * 300; tone(ctx, dest, { type: 'sine', freq: f, freqEnd: f * 2.4, attack: 0.005, decay: 0.1, gain: 0.2, start: 0.03 + i * 0.06 }); }
  }, 0.5);
  bank.define('player.bucket_empty', (ctx, dest, rng) => splash(ctx, dest, rng, 0.55, 1.0), 0.8);
  bank.define('player.swim', (ctx, dest, rng) => splash(ctx, dest, rng, 0.25, 0.7), 0.5);
  // Equipping armor (Update #8): wood is a leathery / wooden clunk, iron and diamond a metallic clink.
  bank.define('player.equip_wood', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.003, decay: 0.12, gain: 0.5, filter: { type: 'lowpass', freq: 650 * (1 + (rng.next() - 0.5) * 0.2), Q: 0.9 } });
    tone(ctx, dest, { type: 'triangle', freq: 210, freqEnd: 150, attack: 0.002, decay: 0.09, gain: 0.25 });
    click(ctx, dest, rng, { gain: 0.25, start: 0.04 });
  }, 0.25);
  bank.define('player.equip_metal', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.002, decay: 0.08, gain: 0.35, filter: { type: 'bandpass', freq: 2600 * (1 + (rng.next() - 0.5) * 0.2), Q: 6 } });
    ping(ctx, dest, rng, { freq: 1900, decay: 0.16, gain: 0.3 });
    ping(ctx, dest, rng, { freq: 2800, decay: 0.12, gain: 0.18, start: 0.03 });
  }, 0.3);
  // Health (Update #9 §8): a short "oof" when hurt, a deeper one on death, crunchy chewing and a gulp.
  bank.define('player.hurt', (ctx, dest, rng) => {
    tone(ctx, dest, { type: 'sine', freq: 230 * (1 + (rng.next() - 0.5) * 0.15), freqEnd: 140, attack: 0.004, decay: 0.2, gain: 0.35 });
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.003, decay: 0.12, gain: 0.3, filter: { type: 'lowpass', freq: 600, Q: 0.8 } });
  }, 0.3);
  bank.define('player.death', (ctx, dest, rng) => {
    tone(ctx, dest, { type: 'sine', freq: 190, freqEnd: 70, attack: 0.005, decay: 0.5, gain: 0.4 });
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.005, decay: 0.35, gain: 0.35, filter: { type: 'lowpass', freq: 420, Q: 0.8 } });
  }, 0.6);
  bank.define('player.eat', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.002, decay: 0.07, gain: 0.35, filter: { type: 'bandpass', freq: 1500 + rng.next() * 900, Q: 1.3 }, gate: { rate: 60 + rng.next() * 40, depth: 0.7 } });
    click(ctx, dest, rng, { gain: 0.25, start: 0.01 });
    click(ctx, dest, rng, { gain: 0.18, start: 0.05 });
  }, 0.15);
  bank.define('player.eat_done', (ctx, dest, rng) => {
    tone(ctx, dest, { type: 'sine', freq: 320, freqEnd: 150, attack: 0.01, decay: 0.22, gain: 0.3 });
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.01, decay: 0.18, gain: 0.2, filter: { type: 'lowpass', freq: 500, Q: 0.7 } });
  }, 0.35);
  // Critical hit: a short bright crack with a high ping on top.
  bank.define('player.crit', (ctx, dest, rng) => {
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.002, decay: 0.09, gain: 0.5, filter: { type: 'highpass', freq: 2500, Q: 0.8 } });
    tone(ctx, dest, { type: 'triangle', freq: 1800, freqEnd: 2600, attack: 0.002, decay: 0.12, gain: 0.25 });
    tone(ctx, dest, { type: 'sine', freq: 3200, freqEnd: 2400, attack: 0.002, decay: 0.08, gain: 0.15, start: 0.03 });
  }, 0.25);
}
