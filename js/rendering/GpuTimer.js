// GpuTimer.js — GPU frame time through the WebGL2 timer query extension (EXT_disjoint_timer_query_webgl2), for the
// "uncapped FPS" readout: the frame rate the game could reach without the display's refresh cap is 1000 / max(CPU work
// time, GPU time). Results arrive a few frames later and any result flagged disjoint is dropped. Browsers without the
// extension (Safari, some Linux drivers) leave `available` false and the readout falls back to a CPU-only estimate.

const MAX_PENDING = 8;

export class GpuTimer {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.ext = gl && typeof gl.createQuery === 'function' ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    this.available = !!this.ext;
    this.pending = [];
    this.active = null;
    /** Last GPU frame time in ms (0 until the first result), and a ~1 s rolling average. */
    this.lastMs = 0;
    this.avgMs = 0;
    this._samples = [];
    this._sampleTotal = 0;
  }

  /** Start timing the frame's GPU work (no-op when a query is still open or the extension is missing). */
  begin() {
    if (!this.available || this.active || this.pending.length >= MAX_PENDING) return;
    const gl = this.gl, q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collect finished queries (call once per frame, outside begin/end). */
  poll() {
    if (!this.available || !this.pending.length) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      if (disjoint) continue; // the counter was reset (a context switch, power management): this result means nothing
      this._push(ns / 1e6);
    }
  }

  _push(ms) {
    this.lastMs = ms;
    this._samples.push(ms); this._sampleTotal += ms;
    if (this._samples.length > 60) this._sampleTotal -= this._samples.shift();
    this.avgMs = this._sampleTotal / this._samples.length;
  }

  dispose() {
    const gl = this.gl;
    if (this.active) { try { gl.endQuery(this.ext.TIME_ELAPSED_EXT); } catch (e) { /* ignore */ } gl.deleteQuery(this.active); this.active = null; }
    for (const q of this.pending) gl.deleteQuery(q);
    this.pending.length = 0;
  }
}

/**
 * The frame rate the game could reach without vsync: 1000 / max(cpu, gpu). `estimate` is true when no GPU timing exists
 * (the number then counts CPU work only).
 */
export function uncappedFps(cpuMs, gpuMs) {
  const ms = Math.max(cpuMs || 0, gpuMs || 0);
  return { fps: ms > 0 ? 1000 / ms : 0, estimate: !(gpuMs > 0) };
}
