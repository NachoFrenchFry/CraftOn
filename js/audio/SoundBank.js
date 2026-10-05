// SoundBank.js — pre-renders every sound recipe into AudioBuffers with OfflineAudioContext (3 variations
// each), so playback is just picking a buffer. Since Update #7 the rendering runs in the background in small
// batches that yield to the main thread between them, most-used sounds first; a sound that is not rendered
// yet simply returns null from get() and is skipped.

import { Random, hashSeed } from '../utils/Random.js';

const VARIATIONS = 3;

export class SoundBank {
  constructor() {
    /** name → { recipe, duration, variations } */
    this.recipes = new Map();
    /** name → AudioBuffer[] */
    this.buffers = new Map();
    this.ready = false;
    /** Promise of the background render once started (resolves to the number of sounds). */
    this.rendering = null;
    this.total = 0;
    this.rendered = 0;
  }

  /**
   * Register a sound. recipe(ctx, destination, rng) builds nodes; duration in seconds.
   */
  define(name, recipe, duration, variations = VARIATIONS) {
    this.recipes.set(name, { recipe, duration, variations });
  }

  async _renderOne(name, entry, variation, sampleRate) {
    const frames = Math.max(1, Math.ceil(entry.duration * sampleRate));
    const ctx = new OfflineAudioContext(1, frames, sampleRate);
    const rng = new Random(hashSeed(`${name}#${variation}`));
    try {
      entry.recipe(ctx, ctx.destination, rng);
      const buffer = await ctx.startRendering();
      this._normalize(buffer);
      return buffer;
    } catch (e) {
      console.warn(`SoundBank: failed to render ${name}`, e);
      return null;
    }
  }

  /** Peak-normalize with headroom and apply short fade in/out so nothing clicks. */
  _normalize(buffer) {
    const d = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    const target = 0.8;
    const s = peak > 0 ? Math.min(target / peak, 6) : 1;
    const fade = Math.min(Math.floor(buffer.sampleRate * 0.003), Math.floor(d.length / 4));
    for (let i = 0; i < d.length; i++) {
      let g = s;
      if (i < fade) g *= i / fade;
      if (i > d.length - fade) g *= (d.length - i) / fade;
      d[i] *= g;
    }
  }

  /** Render every variation of one sound; the buffers appear only once all are done (no half-rendered sets). */
  async _renderSound(name, sampleRate) {
    const entry = this.recipes.get(name);
    const list = [];
    await Promise.all(Array.from({ length: entry.variations }, (_, v) => this._renderOne(name, entry, v, sampleRate).then((b) => { if (b) list.push(b); })));
    this.buffers.set(name, list);
  }

  /**
   * Render every registered sound in the background: `priority` is a list of name prefixes rendered first
   * (UI clicks, player sounds, common blocks…), `batchSize` sounds render together, and the loop yields to the
   * main thread (setTimeout 0) between batches so menus stay responsive. Idempotent: returns the same promise.
   * @returns {Promise<number>} the number of sounds rendered
   */
  renderInBackground(sampleRate, priority = [], batchSize = 3) {
    if (this.rendering) return this.rendering;
    const rank = (name) => { const i = priority.findIndex((p) => name.startsWith(p)); return i < 0 ? priority.length : i; };
    const names = [...this.recipes.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    this.total = names.length;
    this.rendered = 0;
    this.rendering = (async () => {
      for (let i = 0; i < names.length; i += batchSize) {
        await Promise.all(names.slice(i, i + batchSize).map((name) => this._renderSound(name, sampleRate)));
        this.rendered = Math.min(names.length, i + batchSize);
        if (i + batchSize < names.length) await new Promise((r) => setTimeout(r, 0));
      }
      this.ready = true;
      return names.length;
    })();
    return this.rendering;
  }

  /** @deprecated use renderInBackground; kept for callers that want to await everything. */
  renderAll(sampleRate) { return this.renderInBackground(sampleRate); }

  has(name) { return this.buffers.has(name) && this.buffers.get(name).length > 0; }

  /** A random variation of a sound, or null. */
  get(name, rng = Math.random) {
    const list = this.buffers.get(name);
    if (!list || list.length === 0) return null;
    return list[Math.floor(rng() * list.length)];
  }
}
