// GameLoop.js — requestAnimationFrame driver with a fixed 60 Hz physics accumulator, the one place where
// game time is scaled (/tick): the frame's real dt × timeScale feeds the accumulator and is handed to everything that
// animates as `gameDt`; `realDt` goes to the UI, autosave and networking. While game time does not advance (paused,
// /tick freeze, no world) the accumulator stays at 0 and the render gets alpha = 1, so nothing swings between two old
// physics states. /tick step advances whole ticks (1/20 s each) while frozen.

import { PHYSICS_STEP, MAX_PHYSICS_STEPS, MAX_FRAME_DT, TICK_RATE_DEFAULT } from '../config/Constants.js';

export class GameLoop {
  /**
   * @param {(dt:number)=>void} fixedUpdate called at a fixed rate
   * @param {(alpha:number, gameDt:number, realDt:number)=>void} render called once per frame; alpha = interpolation factor
   */
  constructor(fixedUpdate, render) {
    this.fixedUpdate = fixedUpdate;
    this.render = render;
    this.running = false;
    this.accumulator = 0;
    /** Game seconds per real second (/tick rate / 20). */
    this.timeScale = 1;
    /** /tick freeze: game time stops; stepTicks() advances it by whole ticks. */
    this.frozen = false;
    this.pendingGameTime = 0;
    /** Whether game time should advance at all (false while paused in single player, on no world…); set by Game. */
    this.isSimulating = () => true;
    /** Game time passed in the last frame (0 while paused or frozen) and the physics steps it ran. */
    this.lastGameDt = 0;
    this.lastSteps = 0;
    this.lastIntervalMs = 0;
    /** Called after every frame with (intervalMs, cpuMs) — the profiler / benchmark hook. */
    this.onFrameEnd = null;
    this.lastTime = 0;
    this.frameId = 0;
    this.fps = 0;
    /** Frame cap: 0 = unlimited; otherwise frames closer together than 1 / maxFps are skipped. */
    this.maxFps = 0;
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
   * Keep simulating in a hidden tab (hosting a LAN server): browsers throttle page timers in the
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

  /** /tick rate: 20 = normal speed. */
  setTickRate(rate) { this.timeScale = rate / TICK_RATE_DEFAULT; }

  /** /tick step [n]: advance n ticks of game time (1/20 s each) on the next frame, even while frozen. */
  stepTicks(n = 1) { this.pendingGameTime += Math.max(0, n) / TICK_RATE_DEFAULT; }

  _tick(now) {
    if (!this.running) return;
    if (this.maxFps > 0 && !this.workerMode && now - this.lastTime < 1000 / this.maxFps - 1) { this._schedule(); return; } // FPS cap
    this._schedule();
    let dt = (now - this.lastTime) / 1000;
    this.lastIntervalMs = now - this.lastTime; // unclamped, for the profiler / benchmark
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

    // Game time: scaled real time, nothing while frozen or not simulating, plus any stepped ticks.
    const simulating = this.isSimulating();
    let gameDt = simulating && !this.frozen ? dt * this.timeScale : 0;
    let stepped = 0;
    if (this.pendingGameTime > 0 && simulating) { stepped = this.pendingGameTime; this.pendingGameTime = 0; gameDt += stepped; }
    if (!simulating) this.accumulator = 0;
    this.accumulator += gameDt;
    let steps = 0;
    const maxSteps = stepped > 0 ? Math.max(MAX_PHYSICS_STEPS, Math.ceil(stepped / PHYSICS_STEP) + 1) : MAX_PHYSICS_STEPS;
    while (this.accumulator >= PHYSICS_STEP - 1e-9 && steps < maxSteps) {
      this.fixedUpdate(PHYSICS_STEP);
      this.accumulator -= PHYSICS_STEP;
      steps++;
    }
    if (steps === MAX_PHYSICS_STEPS && stepped === 0) this.accumulator = 0; // spiral-of-death guard
    if (this.accumulator < 1e-9) this.accumulator = 0;
    if (this.frozen || !simulating) this.accumulator = 0; // a frozen / paused world renders its latest state (alpha 1), never a blend
    const alpha = this.frozen || !simulating ? 1 : this.accumulator / PHYSICS_STEP;
    this.lastGameDt = gameDt; this.lastSteps = steps;
    this.render(alpha, gameDt, dt);
    if (this.onFrameEnd) this.onFrameEnd(this.lastIntervalMs, performance.now() - now);
  }
}
