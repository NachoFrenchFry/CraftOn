// WorkerPool.js — a small pool of module workers with promise-based request/response messaging.

export class WorkerPool {
  /**
   * @param {string|URL} url module worker script
   * @param {number} size number of workers
   */
  constructor(url, size) {
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(url, { type: 'module' });
      const entry = { worker, busy: 0 };
      worker.onmessage = (e) => this._onMessage(entry, e.data);
      worker.onerror = (e) => console.error('Worker error:', e.message || e);
      this.workers.push(entry);
    }
  }

  get size() { return this.workers.length; }

  /** Total requests in flight. */
  get inFlight() { return this.pending.size; }

  _onMessage(entry, data) {
    entry.busy = Math.max(0, entry.busy - 1);
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    p.resolve(data);
  }

  /** Send to every worker (no reply expected). */
  broadcast(msg) {
    for (const w of this.workers) w.worker.postMessage(msg);
  }

  /** Send a request to the least busy worker; resolves with the reply. */
  post(msg, transfer = []) {
    const id = this.nextId++;
    msg.id = id;
    let best = this.workers[0];
    for (const w of this.workers) if (w.busy < best.busy) best = w;
    best.busy++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      best.worker.postMessage(msg, transfer);
    });
  }

  terminate() {
    for (const w of this.workers) w.worker.terminate();
    this.workers.length = 0;
    this.pending.clear();
  }
}
