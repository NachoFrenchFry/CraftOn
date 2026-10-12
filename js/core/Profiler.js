// Profiler.js — per-system main-thread timers and a frame-time history (Update #14 §0). Game wraps every system of a
// frame in begin()/end() pairs; endFrame() files the frame (rAF interval, CPU time, per-system ms) into ring buffers
// for the F3 graph, into running one-second averages for the F3 breakdown and into totals for the benchmark. No
// allocations after warm-up: the per-frame table keeps fixed keys and the histories are typed arrays. Long tasks
// (anything over 50 ms on the main thread, which a frame measurement can miss while the tab is idle) come from a
// PerformanceObserver when the browser offers one.

const HISTORY = 240;

export class Profiler {
  constructor() {
    /** Milliseconds per system in the frame being measured. */
    this.frame = Object.create(null);
    /** Nesting stack: a child's time is excluded from its parent's, so the per-system numbers add up to the frame. */
    this._stack = [];
    for (let i = 0; i < 24; i++) this._stack.push({ name: '', start: 0, child: 0 });
    this._depth = 0;
    this.names = [];
    /** Totals since reset() (the benchmark reads these) and the worst single frame per system. */
    this.totals = Object.create(null);
    this.maxFrame = Object.create(null);
    /** One-second running averages for the overlay. */
    this.second = Object.create(null);
    this.secondAvg = Object.create(null);
    this._secondFrames = 0;
    this._secondTime = 0;
    /** Frame interval (ms between frames) and CPU time (ms inside the frame) histories, newest at `pos - 1`. */
    this.interval = new Float32Array(HISTORY);
    this.cpu = new Float32Array(HISTORY);
    this.pos = 0;
    this.frames = 0;
    this.lastInterval = 0;
    this.lastCpu = 0;
    this.longestFrame = 0;
    this.longestCpu = 0;
    /** Longest main-thread task (ms) seen by the PerformanceObserver, and how many over 50 ms. */
    this.longestTask = 0;
    this.longTasks = 0;
    this._observer = null;
    this._observe();
  }

  _observe() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this._observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { this.longTasks++; if (e.duration > this.longestTask) this.longestTask = e.duration; }
      });
      this._observer.observe({ entryTypes: ['longtask'] });
    } catch (e) { this._observer = null; }
  }

  /** Start timing a system (nesting allowed: the inner system's time is excluded from the outer one). */
  begin(name) {
    if (this._depth >= this._stack.length) return;
    const e = this._stack[this._depth++];
    e.name = name; e.start = performance.now(); e.child = 0;
  }

  end(name) {
    if (this._depth === 0) return;
    const e = this._stack[this._depth - 1];
    if (e.name !== name) return; // unbalanced: ignore rather than corrupt the stack
    this._depth--;
    const total = performance.now() - e.start;
    this.add(name, total - e.child);
    if (this._depth > 0) this._stack[this._depth - 1].child += total;
  }

  /** Account externally measured time to a system. */
  add(name, ms) {
    if (this.frame[name] === undefined) { this.frame[name] = 0; this.totals[name] = 0; this.maxFrame[name] = 0; this.second[name] = 0; this.secondAvg[name] = 0; this.names.push(name); }
    this.frame[name] += ms;
  }

  /** File the frame: `intervalMs` is the time since the previous frame (unclamped), `cpuMs` the time spent inside it. */
  endFrame(intervalMs, cpuMs) {
    this._depth = 0;
    this.lastInterval = intervalMs; this.lastCpu = cpuMs;
    this.interval[this.pos] = intervalMs; this.cpu[this.pos] = cpuMs;
    this.pos = (this.pos + 1) % HISTORY;
    this.frames++;
    if (intervalMs > this.longestFrame) this.longestFrame = intervalMs;
    if (cpuMs > this.longestCpu) this.longestCpu = cpuMs;
    const names = this.names;
    for (let i = 0; i < names.length; i++) {
      const n = names[i], v = this.frame[n];
      this.totals[n] += v; this.second[n] += v;
      if (v > this.maxFrame[n]) this.maxFrame[n] = v;
      this.frame[n] = 0;
    }
    this._secondFrames++; this._secondTime += intervalMs;
    if (this._secondTime >= 1000) {
      for (let i = 0; i < names.length; i++) { const n = names[i]; this.secondAvg[n] = this.second[n] / this._secondFrames; this.second[n] = 0; }
      this._secondFrames = 0; this._secondTime = 0;
    }
  }

  /** Forget totals and the long-task record (the benchmark calls this when a phase starts). */
  reset() {
    for (const n of this.names) { this.totals[n] = 0; this.maxFrame[n] = 0; }
    this.frames = 0; this.longestFrame = 0; this.longestCpu = 0; this.longestTask = 0; this.longTasks = 0;
  }

  /** The systems sorted by their one-second average, as [name, ms] pairs (allocates; for the 4 Hz overlay only). */
  breakdown() {
    return this.names.map((n) => [n, this.secondAvg[n]]).filter((p) => p[1] > 0.005).sort((a, b) => b[1] - a[1]);
  }
}

/** Percentile of a numeric array (sorted copy; p in 0..1). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}
