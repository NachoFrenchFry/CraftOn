// AmbientSounds.js — looping wind (live nodes with an LFO-modulated lowpass), a pre-rendered water
// bubbling loop and rare cave drips with reverb.

import { createNoiseBuffer, tone, reverb, noiseBurst } from '../SoundSynth.js';
import { Random } from '../../utils/Random.js';

export function registerAmbientSounds(bank) {
  bank.define('ambient.drip', (ctx, dest, rng) => {
    const wet = reverb(ctx, dest, rng, 1.8, 2.5, 0.6);
    const f = 1400 * (1 + (rng.next() - 0.5) * 0.4);
    tone(ctx, wet, { type: 'sine', freq: f, freqEnd: f * 0.6, attack: 0.002, decay: 0.12, gain: 0.35 });
  }, 2.2, 3);
  bank.define('ambient.cave', (ctx, dest, rng) => {
    const wet = reverb(ctx, dest, rng, 2.5, 2, 0.7);
    const f = 110 * (1 + (rng.next() - 0.5) * 0.3);
    tone(ctx, wet, { type: 'sine', freq: f, freqEnd: f * 0.7, attack: 0.6, hold: 0.4, decay: 1.2, gain: 0.25 });
    tone(ctx, wet, { type: 'triangle', freq: f * 1.5, freqEnd: f, attack: 0.8, decay: 1.4, gain: 0.08 });
  }, 3.5, 3);
  bank.define('ambient.water', (ctx, dest, rng) => {
    // Gentle bubbling: many soft low blips over 3 s (looped).
    for (let i = 0; i < 14; i++) {
      const f = 180 + rng.next() * 260;
      tone(ctx, dest, { type: 'sine', freq: f, freqEnd: f * 1.8, attack: 0.02, decay: 0.12 + rng.next() * 0.1, gain: 0.08, start: rng.next() * 2.8 });
    }
    noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.5, hold: 2, decay: 0.5, gain: 0.05, filter: { type: 'lowpass', freq: 500, Q: 0.7 } });
  }, 3.0, 1);
}

/** Live wind loop: brown noise → lowpass (cutoff wandered by a slow LFO) → gain. */
export class WindLoop {
  constructor(ctx, dest) {
    this.ctx = ctx;
    const rng = new Random(0x51ed);
    this.source = ctx.createBufferSource();
    this.source.buffer = createNoiseBuffer(ctx, 4, 'brown', rng);
    this.source.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 400;
    this.filter.Q.value = 0.5;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.08;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 250;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.filter.frequency);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(dest);
    this.source.start();
    this.lfo.start();
    this.target = 0.15;
  }

  /** Smoothly move toward a target volume (0..1). */
  setLevel(level, time) {
    this.gain.gain.setTargetAtTime(level, time, 1.5);
  }
}
