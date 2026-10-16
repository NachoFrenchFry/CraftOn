// ArrayPool.js — typed arrays and ArrayBuffers by size class, so chunk geometry, worker mesh results and the padded
// block copies sent to the workers are reused instead of allocated afresh (no garbage, no re-growing GPU buffers).
// Size classes are 2^k and 1.5 × 2^k elements from 256 up; an array always comes back at least as large as asked.
// Worker-safe (no DOM, no Three).

/** The size class (element count) that holds at least `n` elements: 256, 384, 512, 768, 1024, 1536, … */
export function sizeClass(n) {
  let c = 256;
  while (c < n) {
    const half = c + (c >> 1);
    if (half >= n) return half;
    c <<= 1;
  }
  return c;
}

/** Pool of one array type (Uint32Array, Float32Array, Uint8Array …) keyed by element count. */
export class ArrayPool {
  /**
   * @param {Function} Type typed array constructor
   * @param {number} maxBytes keep at most this many bytes idle in the pool (older extras are dropped)
   */
  constructor(Type, maxBytes = 64 << 20) {
    this.Type = Type;
    this.maxBytes = maxBytes;
    /** size class → arrays */
    this.free = new Map();
    this.idleBytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  /** An array of at least `n` elements (its length is the size class). */
  acquire(n) {
    const c = sizeClass(n);
    const list = this.free.get(c);
    if (list && list.length) { this.hits++; const a = list.pop(); this.idleBytes -= a.byteLength; return a; }
    this.misses++;
    return new this.Type(c);
  }

  /** Give an array back; arrays of a foreign size are kept too as long as their length is a size class. */
  release(a) {
    if (!a || !(a instanceof this.Type) || a.length !== sizeClass(a.length)) return;
    if (this.idleBytes + a.byteLength > this.maxBytes) return; // let it go: the pool is full
    let list = this.free.get(a.length);
    if (!list) { list = []; this.free.set(a.length, list); }
    list.push(a);
    this.idleBytes += a.byteLength;
  }

  clear() { this.free.clear(); this.idleBytes = 0; }
}

/** Pool of raw ArrayBuffers by byte-size class (the worker's mesh result buffers travel as transferables). */
export class BufferPool {
  constructor(maxBytes = 32 << 20) {
    this.maxBytes = maxBytes;
    this.free = new Map();
    this.idleBytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  /** A buffer of at least `bytes` bytes (byteLength is a size class, a multiple of 256 ≥ 1024). */
  acquire(bytes) {
    const c = sizeClass(Math.max(1024, bytes));
    const list = this.free.get(c);
    if (list && list.length) { this.hits++; this.idleBytes -= c; return list.pop(); }
    this.misses++;
    return new ArrayBuffer(c);
  }

  release(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0 || buf.byteLength !== sizeClass(buf.byteLength)) return;
    if (this.idleBytes + buf.byteLength > this.maxBytes) return;
    let list = this.free.get(buf.byteLength);
    if (!list) { list = []; this.free.set(buf.byteLength, list); }
    list.push(buf);
    this.idleBytes += buf.byteLength;
  }

  clear() { this.free.clear(); this.idleBytes = 0; }
}
