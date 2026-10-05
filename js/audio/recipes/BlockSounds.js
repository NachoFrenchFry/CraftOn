// BlockSounds.js — break / place / hit / step recipes for every block sound group.
// Each recipe: (ctx, dest, rng) => void, rendered offline by SoundBank.

import { noiseBurst, tone, ping, click, fmPing } from '../SoundSynth.js';
import { SOUND_GROUP_GAIN } from '../../blocks/BlockSoundGroups.js';

const v = (rng, base, spread) => base * (1 + (rng.next() * 2 - 1) * spread);

// ---- Stone ----
function stoneHit(ctx, dest, rng, gain = 0.5, decay = 0.1) {
  noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.002, decay, gain, filter: { type: 'bandpass', freq: v(rng, 2000, 0.25), Q: 1.5 } });
  tone(ctx, dest, { type: 'sine', freq: v(rng, 120, 0.1), attack: 0.002, decay: 0.04, gain: gain * 0.5 });
}
const stone = {
  hit: (c, d, r) => stoneHit(c, d, r, 0.35, 0.09),
  step: (c, d, r) => stoneHit(c, d, r, 0.3, 0.07),
  place: (c, d, r) => { stoneHit(c, d, r, 0.5, 0.12); tone(c, d, { freq: v(r, 100, 0.1), decay: 0.06, gain: 0.35 }); },
  break: (c, d, r) => {
    for (let i = 0; i < 3; i++) {
      noiseBurst(c, d, r, { type: 'white', attack: 0.002, decay: v(r, 0.13, 0.3), gain: 0.5, start: i * v(r, 0.045, 0.3), filter: { type: 'bandpass', freq: v(r, 1800, 0.35), Q: 1.4 } });
    }
    tone(c, d, { freq: v(r, 110, 0.1), decay: 0.07, gain: 0.4 });
  },
};

// ---- Dirt / gravel ----
function dirtBurst(ctx, dest, rng, gain, decay) {
  noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.004, decay, gain, filter: { type: 'lowpass', freq: v(rng, 1000, 0.2), Q: 0.8 }, gate: { rate: v(rng, 30, 0.3), depth: 0.7 } });
}
const dirt = {
  hit: (c, d, r) => dirtBurst(c, d, r, 0.5, 0.11),
  step: (c, d, r) => dirtBurst(c, d, r, 0.45, 0.1),
  place: (c, d, r) => dirtBurst(c, d, r, 0.6, 0.15),
  break: (c, d, r) => { dirtBurst(c, d, r, 0.7, 0.2); dirtBurst(c, d, r, 0.5, 0.15); },
};

// ---- Grass ----
function grassBurst(ctx, dest, rng, gain, decay) {
  noiseBurst(ctx, dest, rng, { type: 'brown', attack: 0.008, decay, gain, filter: { type: 'lowpass', freq: v(rng, 900, 0.2), Q: 0.7 }, gate: { rate: v(rng, 28, 0.3), depth: 0.6 } });
  noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.01, decay: decay * 0.9, gain: gain * 0.25, filter: { type: 'highpass', freq: v(rng, 4000, 0.2), Q: 0.7 } });
}
const grass = {
  hit: (c, d, r) => grassBurst(c, d, r, 0.45, 0.11),
  step: (c, d, r) => grassBurst(c, d, r, 0.4, 0.1),
  place: (c, d, r) => grassBurst(c, d, r, 0.55, 0.15),
  break: (c, d, r) => { grassBurst(c, d, r, 0.65, 0.2); grassBurst(c, d, r, 0.4, 0.14); },
};

// ---- Sand ----
function sandHiss(ctx, dest, rng, gain, decay) {
  noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.015, decay, gain, filter: { type: 'bandpass', freq: v(rng, 3000, 0.25), Q: 0.9 } });
}
const sand = {
  hit: (c, d, r) => sandHiss(c, d, r, 0.35, 0.15),
  step: (c, d, r) => sandHiss(c, d, r, 0.3, 0.14),
  place: (c, d, r) => sandHiss(c, d, r, 0.45, 0.2),
  break: (c, d, r) => { sandHiss(c, d, r, 0.5, 0.25); sandHiss(c, d, r, 0.3, 0.18); },
};

// ---- Wood ----
function woodKnock(ctx, dest, rng, gain, decay) {
  noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.002, decay, gain, filter: { type: 'bandpass', freq: v(rng, 450, 0.3), Q: 10 } });
  tone(ctx, dest, { type: 'triangle', freq: v(rng, 250, 0.1), freqEnd: 180, attack: 0.002, decay: 0.08, gain: gain * 0.6 });
}
const wood = {
  hit: (c, d, r) => woodKnock(c, d, r, 0.45, 0.1),
  step: (c, d, r) => woodKnock(c, d, r, 0.4, 0.08),
  place: (c, d, r) => woodKnock(c, d, r, 0.55, 0.12),
  break: (c, d, r) => {
    woodKnock(c, d, r, 0.6, 0.15);
    for (let i = 0; i < 5; i++) click(c, d, r, { gain: 0.3, start: 0.02 + r.next() * 0.15, duration: 0.008 });
  },
};

// ---- Plants / leaves ----
function rustle(ctx, dest, rng, gain, count) {
  for (let i = 0; i < count; i++) {
    noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.003, decay: v(rng, 0.012, 0.4), gain: gain * v(rng, 1, 0.3), start: rng.next() * 0.14, filter: { type: 'highpass', freq: v(rng, 5000, 0.2), Q: 0.7 } });
  }
  noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.01, decay: 0.12, gain: gain * 0.4, filter: { type: 'bandpass', freq: v(rng, 3500, 0.2), Q: 0.8 } });
}
const plant = {
  hit: (c, d, r) => rustle(c, d, r, 0.35, 5),
  step: (c, d, r) => rustle(c, d, r, 0.3, 4),
  place: (c, d, r) => rustle(c, d, r, 0.4, 6),
  break: (c, d, r) => rustle(c, d, r, 0.5, 8),
};

// ---- Glass ----
const glass = {
  hit: (c, d, r) => { fmPing(c, d, r, { freq: v(r, 3200, 0.2), decay: 0.08, gain: 0.2 }); click(c, d, r, { gain: 0.2 }); },
  step: (c, d, r) => { fmPing(c, d, r, { freq: v(r, 2800, 0.2), decay: 0.06, gain: 0.15 }); click(c, d, r, { gain: 0.15 }); },
  place: (c, d, r) => { fmPing(c, d, r, { freq: v(r, 2600, 0.2), decay: 0.1, gain: 0.25 }); click(c, d, r, { gain: 0.25 }); },
  break: (c, d, r) => {
    noiseBurst(c, d, r, { type: 'white', attack: 0.002, decay: 0.2, gain: 0.45, filter: { type: 'highpass', freq: 3000, Q: 0.7 } });
    const n = 5 + r.nextInt(4);
    for (let i = 0; i < n; i++) ping(c, d, r, { freq: v(r, 4000, 0.5), decay: v(r, 0.07, 0.6), gain: 0.18, start: r.next() * 0.25, drop: 0.9 });
  },
};

// ---- Snow ----
function snowCrunch(ctx, dest, rng, gain, decay) {
  noiseBurst(ctx, dest, rng, { type: 'pink', attack: 0.006, decay, gain, filter: { type: 'lowpass', freq: v(rng, 1500, 0.2), Q: 0.7 }, gate: { rate: v(rng, 40, 0.3), depth: 0.4 } });
}
const snow = {
  hit: (c, d, r) => snowCrunch(c, d, r, 0.4, 0.12),
  step: (c, d, r) => snowCrunch(c, d, r, 0.35, 0.1),
  place: (c, d, r) => snowCrunch(c, d, r, 0.5, 0.16),
  break: (c, d, r) => { snowCrunch(c, d, r, 0.6, 0.22); snowCrunch(c, d, r, 0.4, 0.15); },
};

// ---- Water ----
export function splash(ctx, dest, rng, gain = 0.6, scale = 1) {
  noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.02, hold: 0.05 * scale, decay: 0.25 * scale, gain, filter: { type: 'bandpass', freq: 400, freqEnd: 2000, Q: 1.2 } });
  noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.1 * scale, decay: 0.25 * scale, gain: gain * 0.6, start: 0.05, filter: { type: 'bandpass', freq: 2000, freqEnd: 500, Q: 1.2 } });
  const n = 3 + rng.nextInt(3);
  for (let i = 0; i < n; i++) {
    const f = v(rng, 500, 0.4);
    tone(ctx, dest, { type: 'sine', freq: f, freqEnd: f * 2.2, attack: 0.005, decay: v(rng, 0.09, 0.4), gain: gain * 0.25, start: 0.02 + rng.next() * 0.3 * scale });
  }
}
const water = {
  hit: (c, d, r) => splash(c, d, r, 0.3, 0.6),
  step: (c, d, r) => splash(c, d, r, 0.25, 0.6),
  place: (c, d, r) => splash(c, d, r, 0.4, 0.8),
  break: (c, d, r) => splash(c, d, r, 0.5, 1),
};

export const BLOCK_SOUND_GROUPS = { stone, dirt, grass, sand, wood, plant, glass, snow, water };

/** Durations per kind (seconds of rendered audio). */
const DURATION = { hit: 0.25, step: 0.22, place: 0.3, break: 0.55 };

/** Register `${group}.${kind}` for every group and kind. */
export function registerBlockSounds(bank) {
  for (const [group, kinds] of Object.entries(BLOCK_SOUND_GROUPS)) {
    const g = SOUND_GROUP_GAIN[group] ?? 1;
    for (const [kind, recipe] of Object.entries(kinds)) {
      bank.define(`${group}.${kind}`, (ctx, dest, rng) => {
        const gain = ctx.createGain();
        gain.gain.value = g;
        gain.connect(dest);
        recipe(ctx, gain, rng);
      }, group === 'water' ? DURATION[kind] + 0.2 : DURATION[kind]);
    }
  }
}
