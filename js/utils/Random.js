// Random.js — seeded PRNG (mulberry32), string → seed hashing, per-chunk/feature RNG derivation.
// Worker-safe.

import { hash3, hashInt } from './MathUtils.js';

/** Deterministic 32-bit PRNG with a Java-like API. */
export class Random {
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Alias for next(). */
  nextFloat() { return this.next(); }

  /** Integer in [0, n). */
  nextInt(n) { return Math.floor(this.next() * n); }

  /** Integer in [lo, hi] inclusive. */
  nextIntRange(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }

  /** Float in [lo, hi). */
  nextRange(lo, hi) { return lo + this.next() * (hi - lo); }

  /** Unsigned 32-bit integer. */
  nextUint32() { return (this.next() * 4294967296) >>> 0; }

  chance(p) { return this.next() < p; }

  pick(array) { return array[this.nextInt(array.length)]; }
}

/** FNV-1a style hash of a string to a 32-bit unsigned seed. Numeric strings hash to their value. */
export function hashSeed(str) {
  const s = String(str).trim();
  if (/^-?\d{1,10}$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n >>> 0;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hashInt(h >>> 0);
}

/** A random seed for new worlds. */
export function randomSeed() {
  return (Math.random() * 4294967296) >>> 0;
}

/** Deterministic RNG for a (seed, chunk, purpose) combination. */
export function chunkRandom(seed, cx, cz, salt = 0) {
  return new Random(hash3(seed ^ salt, cx, cz));
}

/** Derive an independent sub-seed for a named purpose. */
export function deriveSeed(seed, salt) {
  return hashInt((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0);
}
