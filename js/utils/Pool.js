// Pool.js — simple object pools and growable typed-array builders to avoid garbage in hot loops.

/** Generic object pool. */
export class Pool {
  constructor(factory, reset = null) {
    this.factory = factory;
    this.reset = reset;
    this.items = [];
  }

  acquire() {
    const item = this.items.length ? this.items.pop() : this.factory();
    return item;
  }

  release(item) {
    if (this.reset) this.reset(item);
    this.items.push(item);
  }
}

/** Growable typed array with push semantics; `slice()` yields an exact-size copy for transfer. */
export class TypedArrayBuilder {
  constructor(Type, initialCapacity = 4096) {
    this.Type = Type;
    this.array = new Type(initialCapacity);
    this.length = 0;
  }

  reset() { this.length = 0; }

  ensure(extra) {
    const needed = this.length + extra;
    if (needed > this.array.length) {
      let cap = this.array.length * 2;
      while (cap < needed) cap *= 2;
      const next = new this.Type(cap);
      next.set(this.array.subarray(0, this.length));
      this.array = next;
    }
  }

  push3(a, b, c) {
    this.ensure(3);
    const arr = this.array;
    const i = this.length;
    arr[i] = a; arr[i + 1] = b; arr[i + 2] = c;
    this.length += 3;
  }

  push2(a, b) {
    this.ensure(2);
    const arr = this.array;
    const i = this.length;
    arr[i] = a; arr[i + 1] = b;
    this.length += 2;
  }

  push6(a, b, c, d, e, f) {
    this.ensure(6);
    const arr = this.array;
    const i = this.length;
    arr[i] = a; arr[i + 1] = b; arr[i + 2] = c; arr[i + 3] = d; arr[i + 4] = e; arr[i + 5] = f;
    this.length += 6;
  }

  /** Exact-size copy. */
  slice() { return this.array.slice(0, this.length); }
}
