// MobSounds.js — procedural cow moo, pig oink and sheep baa, each with hurt (shorter, higher) and death
// (lower, drawn out) variants. Played spatially by MobManager through the blocks bus.

import { noiseBurst, tone } from '../SoundSynth.js';

/** Vowel-like formant: an oscillator through a resonant bandpass, with a pitch glide and vibrato. */
function voice(ctx, dest, rng, { type, freq, freqEnd, formant, q, duration, gain, vibrato = 0, vibratoRate = 6, attack = 0.04 }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, 0);
  osc.frequency.exponentialRampToValueAtTime(freqEnd, duration);
  if (vibrato > 0) {
    const lfo = ctx.createOscillator(); lfo.frequency.value = vibratoRate;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = vibrato;
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency); lfo.start(0); lfo.stop(duration + 0.05);
  }
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = formant; bp.Q.value = q;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, 0);
  env.gain.linearRampToValueAtTime(gain, attack);
  env.gain.setValueAtTime(gain, Math.max(attack, duration * 0.6));
  env.gain.exponentialRampToValueAtTime(0.0001, duration);
  osc.connect(bp); bp.connect(env); env.connect(dest);
  osc.start(0); osc.stop(duration + 0.02);
}

const v = (rng, base, spread) => base * (1 + (rng.next() * 2 - 1) * spread);

function moo(ctx, dest, rng, scale = 1, pitch = 1) {
  const f = v(rng, 130, 0.15) * pitch;
  voice(ctx, dest, rng, { type: 'sawtooth', freq: f * 0.9, freqEnd: f * 1.15, formant: 420 * pitch, q: 3, duration: 1.0 * scale, gain: 0.5, vibrato: 4, vibratoRate: 5, attack: 0.08 });
  voice(ctx, dest, rng, { type: 'sawtooth', freq: f * 0.9, freqEnd: f * 1.1, formant: 900 * pitch, q: 4, duration: 1.0 * scale, gain: 0.2, attack: 0.1 });
}
function oink(ctx, dest, rng, scale = 1, pitch = 1) {
  const n = 2 + rng.nextInt(2);
  for (let i = 0; i < n; i++) {
    const start = i * 0.16 * scale;
    const osc = ctx.createOscillator(); osc.type = 'square';
    const f = v(rng, 150, 0.2) * pitch;
    osc.frequency.setValueAtTime(f, start); osc.frequency.exponentialRampToValueAtTime(f * 0.7, start + 0.12 * scale);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700 * pitch; bp.Q.value = 2.5;
    const env = ctx.createGain(); env.gain.setValueAtTime(0.0001, start); env.gain.linearRampToValueAtTime(0.35, start + 0.015); env.gain.exponentialRampToValueAtTime(0.0001, start + 0.12 * scale);
    osc.connect(bp); bp.connect(env); env.connect(dest); osc.start(start); osc.stop(start + 0.14 * scale);
    noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.005, decay: 0.08 * scale, gain: 0.25, start, filter: { type: 'bandpass', freq: 900 * pitch, Q: 1.5 } });
  }
}
function baa(ctx, dest, rng, scale = 1, pitch = 1) {
  const f = v(rng, 360, 0.15) * pitch;
  voice(ctx, dest, rng, { type: 'sawtooth', freq: f, freqEnd: f * 0.85, formant: 1100 * pitch, q: 5, duration: 0.6 * scale, gain: 0.4, vibrato: 25, vibratoRate: 9, attack: 0.03 });
  voice(ctx, dest, rng, { type: 'triangle', freq: f * 2, freqEnd: f * 1.7, formant: 2400 * pitch, q: 6, duration: 0.55 * scale, gain: 0.12, vibrato: 30, vibratoRate: 9 });
}

export function registerMobSounds(bank) {
  bank.define('mob.cow', (c, d, r) => moo(c, d, r, 1, 1), 1.3);
  bank.define('mob.cow_hurt', (c, d, r) => moo(c, d, r, 0.45, 1.35), 0.6);
  bank.define('mob.cow_death', (c, d, r) => moo(c, d, r, 1.5, 0.75), 1.8);
  bank.define('mob.pig', (c, d, r) => oink(c, d, r, 1, 1), 0.7);
  bank.define('mob.pig_hurt', (c, d, r) => oink(c, d, r, 0.6, 1.4), 0.4);
  bank.define('mob.pig_death', (c, d, r) => oink(c, d, r, 1.8, 0.7), 1.2);
  bank.define('mob.sheep', (c, d, r) => baa(c, d, r, 1, 1), 0.8);
  bank.define('mob.sheep_hurt', (c, d, r) => baa(c, d, r, 0.5, 1.3), 0.45);
  bank.define('mob.sheep_death', (c, d, r) => baa(c, d, r, 1.6, 0.7), 1.3);
}
