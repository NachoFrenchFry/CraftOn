// WorkerPool.js — a small pool of module workers with promise-based request/response messaging that never leaves a
// request hanging. A job that throws inside a worker comes back as { id, error } (the worker wraps every handler) and
// rejects its promise; a worker that crashes (onerror / onmessageerror) rejects everything pending on it and is
// replaced by a fresh one that gets the broadcast init state again; every request has a timeout (15 s, four times that
// for /locate) that rejects and frees its slot, and a worker whose requests keep timing out with no reply in between is
// treated as dead (terminate() fires no event) and replaced too. The owner (ChunkManager) retries rejected
// jobs with a backoff; `stats` and the `onError` / `onReplaced` hooks feed the F3 counts and the logs.

export const REQUEST_TIMEOUT_MS = 15000;

export class WorkerPool {
  /**
   * @param {string|URL} url module worker script
   * @param {number} size number of workers
   * @param {{timeoutMs?: number, label?: string}} [options]
   */
  constructor(url, size, { timeoutMs = REQUEST_TIMEOUT_MS, label = 'worker' } = {}) {
    this.url = url;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.workers = [];
    /** id → { resolve, reject, entry, type, timer } */
    this.pending = new Map();
    this.nextId = 1;
    /** Broadcast messages (the init state: seed, cutouts, far colours…), the newest per set of keys, replayed to a replacement worker. */
    this.initMessages = [];
    this.stats = { errors: 0, crashes: 0, timeouts: 0, replaced: 0, lastError: null };
    /** Hooks: onError({ kind: 'error' | 'crash' | 'timeout', type, worker, message, stack }) for every failure; onReplaced(index, reason). */
    this.onError = null;
    this.onReplaced = null;
    this.terminated = false;
    for (let i = 0; i < size; i++) this.workers.push(this._spawn(i));
  }

  get size() { return this.workers.length; }

  /** Total requests in flight. */
  get inFlight() { return this.pending.size; }

  _spawn(index) {
    const worker = new Worker(this.url, { type: 'module' });
    const entry = { worker, index, ids: new Set(), timeoutsInRow: 0, alive: true };
    worker.onmessage = (e) => this._onMessage(entry, e.data);
    worker.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault(); // handled here: never a page error
      this._onCrash(entry, e && e.message ? `${e.message} (${e.filename || '?'}:${e.lineno || 0})` : 'worker error');
    };
    worker.onmessageerror = () => this._onCrash(entry, 'messageerror (a message could not be deserialized)');
    return entry;
  }

  _onMessage(entry, data) {
    if (!data || data.id === undefined) return;
    const p = this.pending.get(data.id);
    entry.ids.delete(data.id);
    if (!p) return; // it timed out earlier: the late reply is dropped
    this.pending.delete(data.id);
    clearTimeout(p.timer);
    entry.timeoutsInRow = 0;
    if (data.error) {
      const message = data.error.message || String(data.error);
      const err = new Error(`${p.type} job failed in worker ${entry.index}: ${message}`);
      err.job = p.type; err.workerStack = data.error.stack || ''; err.recoverable = true;
      this.stats.errors++; this.stats.lastError = err.message;
      if (this.onError) this.onError({ kind: 'error', type: p.type, worker: entry.index, message, stack: err.workerStack });
      p.reject(err);
      return;
    }
    data.worker = entry.index; // which worker answered (buffers go back to its pool)
    p.resolve(data);
  }

  /** Reject every request pending on a worker (it crashed, is dead, or the pool is closing). */
  _rejectAll(entry, reason) {
    for (const id of [...entry.ids]) {
      const p = this.pending.get(id);
      entry.ids.delete(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const err = new Error(`${p.type} job lost: ${reason}`);
      err.job = p.type; err.recoverable = true;
      p.reject(err);
    }
  }

  _onCrash(entry, message) {
    if (!entry.alive || this.terminated) return;
    this.stats.crashes++; this.stats.lastError = message;
    if (this.onError) this.onError({ kind: 'crash', type: null, worker: entry.index, message });
    this._replace(entry, `crashed: ${message}`);
  }

  /** Terminate a worker, reject its pending requests and put a fresh one (with the init state) in its slot. */
  _replace(entry, reason) {
    entry.alive = false;
    this._rejectAll(entry, `worker ${entry.index} ${reason}`);
    try { entry.worker.terminate(); } catch (e) { /* already gone */ }
    const fresh = this._spawn(entry.index);
    this.workers[entry.index] = fresh;
    for (const m of this.initMessages) fresh.worker.postMessage(m);
    this.stats.replaced++;
    if (this.onReplaced) this.onReplaced(entry.index, reason);
  }

  /** Send to every worker (no reply expected); remembered so a replacement worker gets the same state. */
  broadcast(msg) {
    const shape = (m) => m.type + ':' + Object.keys(m).filter((k) => k !== 'type').sort().join(',');
    const s = shape(msg);
    this.initMessages = this.initMessages.filter((m) => shape(m) !== s);
    this.initMessages.push(msg);
    for (const w of this.workers) if (w.alive) w.worker.postMessage(msg);
  }

  /** Send to one worker by index (no reply expected), e.g. buffers going back to the worker that produced them. */
  send(index, msg, transfer = []) {
    const w = this.workers[index];
    if (w && w.alive) w.worker.postMessage(msg, transfer);
  }

  /** Send a request to the least busy worker; resolves with the reply, rejects on a worker error, crash or timeout. */
  post(msg, transfer = []) {
    const id = this.nextId++;
    msg.id = id;
    let best = this.workers[0];
    for (const w of this.workers) if (w.ids.size < best.ids.size) best = w;
    const type = msg.type;
    return new Promise((resolve, reject) => {
      if (!best || this.terminated) { reject(new Error(`${type} job refused: the pool is closed`)); return; }
      const ms = type === 'locate' ? this.timeoutMs * 4 : this.timeoutMs;
      const timer = setTimeout(() => this._onTimeout(id, best, ms), ms);
      this.pending.set(id, { resolve, reject, entry: best, type, timer });
      best.ids.add(id);
      try { best.worker.postMessage(msg, transfer); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); best.ids.delete(id); reject(e); }
    });
  }

  _onTimeout(id, entry, ms) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    entry.ids.delete(id);
    this.stats.timeouts++; this.stats.lastError = `${p.type} timed out after ${ms} ms`;
    if (this.onError) this.onError({ kind: 'timeout', type: p.type, worker: entry.index, message: `${p.type} job timed out after ${ms} ms` });
    const err = new Error(`${p.type} job timed out after ${ms} ms on worker ${entry.index}`);
    err.job = p.type; err.recoverable = true;
    p.reject(err);
    // Nothing came back for two requests in a row: the worker is taken for dead (a terminated worker fires no event).
    entry.timeoutsInRow++;
    if (entry.alive && entry.timeoutsInRow >= 2) this._replace(entry, `answered nothing ${entry.timeoutsInRow} times in a row (timeouts)`);
  }

  terminate() {
    this.terminated = true;
    for (const w of this.workers) { w.alive = false; this._rejectAll(w, 'pool terminated'); w.worker.terminate(); }
    this.workers.length = 0;
    this.pending.clear();
  }
}
