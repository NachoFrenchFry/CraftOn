// SoundSynth.js — low-level Web Audio building blocks used by the sound recipes: noise buffers,
// envelopes, filtered bursts, oscillator sweeps, pings, clicks and a reverb impulse.

/** Fill a mono buffer with white / pink / brown noise from a seeded RNG. */
export function createNoiseBuffer(ctx, seconds, type = 'white', rng) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.ceil(seconds * sr));
  const buffer = ctx.createBuffer(1, n, sr);
  const d = buffer.getChannelData(0);
  const rand = () => rng.next() * 2 - 1;
  if (type === 'white') {
    for (let i = 0; i < n; i++) d[i] = rand();
  } else if (type === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rand();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = rand();
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buffer;
}

/** Schedule an attack / hold / exponential-decay envelope on a GainNode. */
export function envelope(gain, t0, { attack = 0.003, hold = 0, decay = 0.1, peak = 1 }) {
  const g = gain.gain;
  g.setValueAtTime(0.0001, t0);
  g.linearRampToValueAtTime(peak, t0 + attack);
  if (hold > 0) g.setValueAtTime(peak, t0 + attack + hold);
  g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
  return t0 + attack + hold + decay;
}

/**
 * A filtered noise burst. opts: type, duration, attack, decay, gain, start,
 * filter {type, freq, Q, freqEnd}, gate {rate, depth}.
 */
export function noiseBurst(ctx, dest, rng, opts) {
  const { type = 'white', attack = 0.003, decay = 0.12, gain = 0.5, start = 0, filter = null, gate = null, hold = 0 } = opts;
  const total = attack + hold + decay + 0.02;
  const src = ctx.createBufferSource();
  src.buffer = createNoiseBuffer(ctx, total, type, rng);
  let node = src;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type || 'bandpass';
    f.frequency.setValueAtTime(filter.freq, start);
    if (filter.freqEnd) f.frequency.exponentialRampToValueAtTime(filter.freqEnd, start + total);
    f.Q.value = filter.Q ?? 1;
    node.connect(f);
    node = f;
  }
  if (gate) {
    const gg = ctx.createGain();
    const steps = Math.ceil(total * gate.rate);
    for (let i = 0; i < steps; i++) {
      const t = start + i / gate.rate;
      gg.gain.setValueAtTime(rng.chance(0.5) ? 1 : 1 - gate.depth, t);
    }
    node.connect(gg);
    node = gg;
  }
  const env = ctx.createGain();
  envelope(env, start, { attack, hold, decay, peak: gain });
  node.connect(env);
  env.connect(dest);
  src.start(start);
  src.stop(start + total);
  return start + total;
}

/** An oscillator with an optional pitch sweep and envelope. */
export function tone(ctx, dest, opts) {
  const { type = 'sine', freq = 440, freqEnd = null, attack = 0.003, decay = 0.1, gain = 0.3, start = 0, hold = 0 } = opts;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  const total = attack + hold + decay;
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, start + total);
  const env = ctx.createGain();
  envelope(env, start, { attack, hold, decay, peak: gain });
  osc.connect(env);
  env.connect(dest);
  osc.start(start);
  osc.stop(start + total + 0.01);
  return start + total;
}

/** Short sine "ping" with a slight downward pitch drop. */
export function ping(ctx, dest, rng, { freq = 1200, decay = 0.08, gain = 0.2, start = 0, drop = 0.85 } = {}) {
  return tone(ctx, dest, { type: 'sine', freq, freqEnd: freq * drop, attack: 0.002, decay, gain, start });
}

/** Tiny click: a few ms of noise. */
export function click(ctx, dest, rng, { gain = 0.3, start = 0, duration = 0.005 } = {}) {
  return noiseBurst(ctx, dest, rng, { type: 'white', attack: 0.0005, decay: duration, gain, start, filter: { type: 'highpass', freq: 2000, Q: 0.7 } });
}

/** FM ping: carrier modulated by a decaying modulator, for bell-like tinks. */
export function fmPing(ctx, dest, rng, { freq = 2000, ratio = 2.5, index = 200, decay = 0.1, gain = 0.2, start = 0 } = {}) {
  const car = ctx.createOscillator();
  const mod = ctx.createOscillator();
  const modGain = ctx.createGain();
  car.frequency.value = freq;
  mod.frequency.value = freq * ratio;
  modGain.gain.setValueAtTime(index, start);
  modGain.gain.exponentialRampToValueAtTime(1, start + decay);
  mod.connect(modGain);
  modGain.connect(car.frequency);
  const env = ctx.createGain();
  envelope(env, start, { attack: 0.002, decay, peak: gain });
  car.connect(env);
  env.connect(dest);
  car.start(start); mod.start(start);
  car.stop(start + decay + 0.02); mod.stop(start + decay + 0.02);
  return start + decay;
}

/** Decaying-noise impulse response for a simple convolution reverb. */
export function reverbImpulse(ctx, seconds, decayPower, rng) {
  const sr = ctx.sampleRate;
  const n = Math.ceil(seconds * sr);
  const buffer = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (rng.next() * 2 - 1) * Math.pow(1 - i / n, decayPower);
  }
  return buffer;
}

/** Convolver node with a generated impulse, wired to `dest`; returns the input node. */
export function reverb(ctx, dest, rng, seconds = 1.5, decayPower = 3, wet = 0.4) {
  const conv = ctx.createConvolver();
  conv.buffer = reverbImpulse(ctx, seconds, decayPower, rng);
  const wetGain = ctx.createGain();
  wetGain.gain.value = wet;
  conv.connect(wetGain);
  wetGain.connect(dest);
  const input = ctx.createGain();
  input.connect(conv);
  input.connect(dest);
  return input;
}
