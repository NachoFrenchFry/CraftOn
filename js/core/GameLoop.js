// GameLoop.js — requestAnimationFrame driver with a fixed 60 Hz physics accumulator.

import { PHYSICS_STEP, MAX_PHYSICS_STEPS, MAX_FRAME_DT } from '../config/Constants.js';

export class GameLoop {
  /**
   * @param {(dt:number)=>void} fixedUpdate called at a fixed rate
   * @param {(alpha:number, dt:number)=>void} render called once per frame; alpha = interpolation factor
   */
  constructor(fixedUpdate, render) {
    this.fixedUpdate = fixedUpdate;
    this.render = render;
    this.running = false;
    this.accumulator = 0;
    this.lastTime = 0;
    this.frameId = 0;
    this.fps = 0;
    this._fpsFrames = 0;
    this._fpsTime = 0;
    /** When true, ticks come from setTimeout instead of requestAnimationFrame (testing / background). */
    this.timerMode = false;
    this.timerInterval = 16;
    this._scheduledWithTimer = false;
    /** Ticks come from a Web Worker (not throttled in hidden tabs) while a host's tab is in the background. */
    this.workerMode = false;
    this.worker = null;
    this._tick = this._tick.bind(this);
  }

  /**
   * Keep simulating in a hidden tab (hosting a LAN server, Update #8): browsers throttle page timers in the
   * background, so a tiny worker posts the ticks instead. Turned off again when the tab becomes visible.
   */
  setHiddenTicker(enabled) {
    if (enabled === this.workerMode) return;
    this.workerMode = enabled;
    if (enabled) {
      this._cancel();
      if (!this.worker) {
        const src = 'let t = null; self.onmessage = (e) => { if (t) clearInterval(t); t = setInterval(() => self.postMessage(0), Math.max(16, e.data.interval || 50)); };';
        this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        this.worker.onmessage = () => { if (this.running && this.workerMode) this._tick(performance.now()); };
      }
      this.worker.postMessage({ interval: this.timerMode ? this.timerInterval : 50 });
    } else {
      if (this.worker) { this.worker.terminate(); this.worker = null; }
      if (this.running) this._schedule();
    }
  }

  _schedule() {
    if (this.workerMode) return; // the worker drives the ticks
    this._scheduledWithTimer = this.timerMode;
    if (this.timerMode) this.frameId = setTimeout(() => this._tick(performance.now()), this.timerInterval);
    else this.frameId = requestAnimationFrame(this._tick);
  }

  _cancel() {
    if (this._scheduledWithTimer) clearTimeout(this.frameId); else cancelAnimationFrame(this.frameId);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this._schedule();
  }

  stop() {
    this.running = false;
    this._cancel();
  }

  /** Reset timing after a pause so the accumulator doesn't try to catch up. */
  resetTiming() {
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  _tick(now) {
    if (!this.running) return;
    this._schedule();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    if (dt < 0) dt = 0;

    this._fpsFrames++;
    this._fpsTime += dt;
    if (this._fpsTime >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsTime);
      this._fpsFrames = 0;
      this._fpsTime = 0;
    }

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_STEP && steps < MAX_PHYSICS_STEPS) {
      this.fixedUpdate(PHYSICS_STEP);
      this.accumulator -= PHYSICS_STEP;
      steps++;
    }
    if (steps === MAX_PHYSICS_STEPS) this.accumulator = 0; // spiral-of-death guard
    const alpha = this.accumulator / PHYSICS_STEP;
    this.render(alpha, dt);
  }
}
