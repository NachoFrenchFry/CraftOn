// Benchmark.js — the built-in benchmark (?bench): a fixed seed and render distance at a fixed 1280×720
// internal resolution; wait for the spawn area to load, stand still for 10 s, then fly a fixed 45-second path at
// sprint-flying speed across forest, ocean, mountains and a desert lava lake. Every frame's interval and CPU time, the
// per-system milliseconds (Profiler), triangles, draw calls and geometry memory are collected; the report is printed
// as JSON (window.__bench, console CRAFTON_BENCH) and shown on screen at the end. The world is a throwaway on the
// mock cloud; settings are not persisted while a benchmark runs (Settings.transient).

import { State } from './GameState.js';
import { percentile } from './Profiler.js';
import { SPRINT_FLY_SPEED } from '../config/Constants.js';

export const BENCH_SEED_TEXT = 'bench1';
const STAND_SECONDS = 10;
const FLY_SECONDS = 45;
const LOAD_TIMEOUT_SECONDS = 120;
/** The flight path for seed "bench1" (world x, z): desert lava lakes, forest, the ocean, the mountains east of the spawn. */
const WAYPOINTS = [[0, -200], [170, -270], [400, -210], [100, -50]];
const CRUISE_MIN_Y = 80;
const CLEARANCE = 12;
const CLIMB_RATE = 15;

export class Benchmark {
  /** @param {import('./Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.active = false;
    this.phase = 'idle';
    this.report = null;
    this.phaseTime = 0;
    this.loadTime = 0;
    this.samples = null;
    this.pathPos = 0;
    this.pathLength = 0;
    this.legs = [];
    this.y = 0;
    this.panel = null;
  }

  /** Arm the benchmark: it starts when the world reaches PLAYING. */
  start() {
    this.active = true;
    this.phase = 'waiting';
    const onState = (s) => { if (s === State.PLAYING && this.phase === 'waiting') { this.game.events.off('state:changed', onState); this._begin(); } };
    this.game.events.on('state:changed', onState);
  }

  _begin() {
    const g = this.game, p = g.player;
    p.gameMode = 'creative';
    p.flying = true;
    p.pitch = -0.25;
    this.phase = 'loading';
    this.phaseTime = 0;
    this.loadTime = 0;
    this.startPos = { x: p.position.x, y: p.position.y, z: p.position.z };
    this.y = p.position.y;
    this._buildPath();
    this.samples = this._newSamples();
    this.standing = null; this.flying = null;
    g.ui.hud.showToast('Benchmark: loading the spawn area…', false);
  }

  _buildPath() {
    const p = this.game.player;
    const pts = [[p.position.x, p.position.z], ...WAYPOINTS];
    this.legs = [];
    this.pathLength = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const len = Math.hypot(bx - ax, bz - az);
      this.legs.push({ ax, az, bx, bz, len, start: this.pathLength });
      this.pathLength += len;
    }
    this.pathPos = 0;
  }

  _newSamples() {
    return { interval: [], cpu: [], gpu: [], tris: [], calls: [], seconds: 0, heapSamples: 0, heapGrowth: 0, heapLast: 0, heapTimer: 0 };
  }

  /** Per frame, before the systems run: moves the player along the path; `realDt` in seconds. */
  update(realDt) {
    if (!this.active) return;
    const g = this.game;
    if (this.phase === 'loading') {
      this.loadTime += realDt;
      const p = g.player;
      const cx = Math.floor(p.position.x) >> 4, cz = Math.floor(p.position.z) >> 4;
      const st = g.chunkManager.stats();
      const done = g.chunkManager.progress(cx, cz, g.chunkManager.renderDistance) >= 0.98 && st.genQueue === 0;
      if (done || this.loadTime > LOAD_TIMEOUT_SECONDS) {
        this.loaded = { seconds: +this.loadTime.toFixed(1), complete: done, chunks: st.loaded };
        this._enter('standing');
      }
      return;
    }
    if (this.phase === 'standing') {
      this.phaseTime += realDt;
      if (this.phaseTime >= STAND_SECONDS) { this.standing = this._summarize(this.samples); this._enter('flying'); }
      return;
    }
    if (this.phase === 'flying') {
      this.phaseTime += realDt;
      this._fly(realDt);
      if (this.phaseTime >= FLY_SECONDS) { this.flying = this._summarize(this.samples); this._finish(); }
    }
  }

  _enter(phase) {
    this.phase = phase;
    this.phaseTime = 0;
    this.samples = this._newSamples();
    this.game.profiler.reset();
    this.game.ui.hud.showToast(phase === 'standing' ? 'Benchmark: standing still (10 s)' : 'Benchmark: flying the path (45 s)', false);
  }

  _fly(dt) {
    const g = this.game, p = g.player;
    this.pathPos = Math.min(this.pathLength, this.pathPos + SPRINT_FLY_SPEED * dt);
    let leg = this.legs[this.legs.length - 1];
    for (const l of this.legs) if (this.pathPos <= l.start + l.len) { leg = l; break; }
    const t = leg.len > 0 ? Math.min(1, (this.pathPos - leg.start) / leg.len) : 1;
    const x = leg.ax + (leg.bx - leg.ax) * t, z = leg.az + (leg.bz - leg.az) * t;
    const dx = leg.bx - leg.ax, dz = leg.bz - leg.az;
    if (dx !== 0 || dz !== 0) p.yaw = Math.atan2(-dx, -dz);
    // Cruise at least CLEARANCE blocks over the terrain ahead, never below the cruise floor; climb and sink smoothly.
    let target = CRUISE_MIN_Y;
    for (let k = 0; k <= 3; k++) {
      const top = g.world.getTopY(Math.floor(x + (dx / (leg.len || 1)) * k * 8), Math.floor(z + (dz / (leg.len || 1)) * k * 8));
      if (top >= 0) target = Math.max(target, top + CLEARANCE);
    }
    const maxStep = CLIMB_RATE * dt;
    this.y += Math.max(-maxStep, Math.min(maxStep, target - this.y));
    p.teleport(x, this.y, z);
    p.pitch = -0.25;
  }

  /** Per frame, after the render: file the frame into the active phase. */
  record(intervalMs, cpuMs) {
    if (!this.active || !this.samples || this.phase === 'loading' || this.phase === 'done') return;
    const s = this.samples, ws = this.game.renderer.worldStats, gt = this.game.renderer.gpuTimer;
    s.interval.push(intervalMs); s.cpu.push(cpuMs); s.tris.push(ws.triangles); s.calls.push(ws.calls); s.seconds += intervalMs / 1000;
    if (gt && gt.available && gt.lastMs > 0) s.gpu.push(gt.lastMs);
    // JS heap allocation rate: the sum of the heap's growth between samples (a garbage collection shrinks it; those
    // drops are ignored), every quarter second. Chromium only (performance.memory).
    s.heapTimer += intervalMs;
    if (s.heapTimer >= 250 && performance.memory) {
      s.heapTimer = 0;
      const used = performance.memory.usedJSHeapSize;
      if (s.heapSamples > 0 && used > s.heapLast) s.heapGrowth += used - s.heapLast;
      s.heapLast = used; s.heapSamples++;
    }
  }

  _summarize(s) {
    const n = s.interval.length;
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const r1 = (v) => Math.round(v * 10) / 10;
    const gpu = s.gpu.length ? { p50: r1(percentile(s.gpu, 0.5)), p95: r1(percentile(s.gpu, 0.95)), p99: r1(percentile(s.gpu, 0.99)), max: r1(Math.max(0, ...s.gpu)) } : null;
    const cpuP50 = percentile(s.cpu, 0.5);
    const unc = 1000 / Math.max(0.01, cpuP50, gpu ? gpu.p50 : 0);
    const heapAllocMBps = s.heapSamples > 1 && s.seconds > 0 ? Math.round(s.heapGrowth / 1048576 / s.seconds * 100) / 100 : null;
    return {
      frames: n,
      seconds: r1(s.seconds),
      fps: r1(n / Math.max(0.001, s.seconds)),
      frameMs: { p50: r1(percentile(s.interval, 0.5)), p95: r1(percentile(s.interval, 0.95)), p99: r1(percentile(s.interval, 0.99)), max: r1(Math.max(0, ...s.interval)) },
      cpuMs: { p50: r1(percentile(s.cpu, 0.5)), p95: r1(percentile(s.cpu, 0.95)), p99: r1(percentile(s.cpu, 0.99)), max: r1(Math.max(0, ...s.cpu)) },
      over33: s.interval.filter((v) => v > 33).length,
      over50: s.interval.filter((v) => v > 50).length,
      triangles: { avg: Math.round(avg(s.tris)), max: Math.max(0, ...s.tris) },
      drawCalls: { avg: Math.round(avg(s.calls)), max: Math.max(0, ...s.calls) },
      systems: this._systems(n),
      longestTaskMs: r1(this.game.profiler.longestTask),
      gpuMs: gpu, uncappedFps: r1(unc), uncappedEstimate: !gpu, heapAllocMBps,
      longTasks: this.game.profiler.longTasks,
    };
  }

  _systems(frames) {
    const pr = this.game.profiler, out = {};
    for (const name of pr.names) {
      const total = pr.totals[name];
      if (total < 0.05) continue;
      out[name] = { totalMs: Math.round(total), perFrameMs: Math.round((total / Math.max(1, frames)) * 100) / 100, maxFrameMs: Math.round(pr.maxFrame[name] * 10) / 10 };
    }
    return out;
  }

  _geometry() {
    const mm = this.game.meshManager;
    let bytes = 0, meshes = 0, used = 0;
    if (mm && mm.geometryBytes) { bytes = mm.geometryBytes(); meshes = mm.meshCount; used = mm.geometryUsedBytes ? mm.geometryUsedBytes() : bytes; }
    // bytes = what the GPU holds (pass buffers at their allocated size plus the shared index); used = the vertices in them
    return { bytes, megabytes: Math.round(bytes / 1048576 * 10) / 10, usedBytes: used, usedMegabytes: Math.round(used / 1048576 * 10) / 10, meshes, geometries: this.game.renderer.info.memory.geometries };
  }

  _finish() {
    const g = this.game;
    this.phase = 'done';
    const gl = g.renderer.renderer.getContext();
    let renderer = 'unknown';
    try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { /* ignore */ }
    const s = g.settings;
    this.report = {
      seed: BENCH_SEED_TEXT,
      renderer,
      resolution: `${g.renderer.renderer.domElement.width}x${g.renderer.renderer.domElement.height}`,
      devicePixelRatio: window.devicePixelRatio,
      cores: navigator.hardwareConcurrency || null,
      settings: { renderDistance: s.get('renderDistance'), simulationDistance: s.get('simulationDistance'), renderScale: g.renderer.renderScale, fancyLeaves: s.get('fancyLeaves'), smoothLighting: s.get('smoothLighting'), shadersOn: s.get('shadersOn'), chunkUpdates: s.get('chunkUpdates') },
      loading: this.loaded,
      standing: this.standing,
      flying: this.flying,
      geometry: this._geometry(),
      chunksLoaded: g.world.chunks.size,
      /** Draw-range culling at the end of the flight: triangles the contiguous visible spans draw vs. those of the sections the walk reached. */
      culling: g.meshManager && g.meshManager.stats ? { spanTriangles: Math.round(g.meshManager.stats.spanTriangles || 0), reachedTriangles: Math.round(g.meshManager.stats.reachedTriangles || 0) } : null,
      summary: null,
    };
    const st = this.standing, fl = this.flying;
    this.report.summary = {
      fpsStanding: st.fps, fpsFlying: fl.fps,
      flyingFrameMs: fl.frameMs, flyingCpuMs: fl.cpuMs,
      over33: st.over33 + fl.over33, over50: st.over50 + fl.over50,
      longestTaskMs: Math.max(st.longestTaskMs, fl.longestTaskMs),
      longestFrameMs: Math.max(st.frameMs.max, fl.frameMs.max),
      triangles: fl.triangles.avg, drawCalls: fl.drawCalls.avg, geometryMB: this.report.geometry.megabytes,
      geometryBytes: this.report.geometry.bytes, geometryUsedMB: this.report.geometry.usedMegabytes, gpuMsP50: fl.gpuMs ? fl.gpuMs.p50 : null, uncappedFps: fl.uncappedFps, uncappedEstimate: fl.uncappedEstimate, heapAllocMBps: fl.heapAllocMBps, heapAllocStandingMBps: st.heapAllocMBps,
      spanTriangles: this.report.culling ? this.report.culling.spanTriangles : null, reachedTriangles: this.report.culling ? this.report.culling.reachedTriangles : null,
      loadSeconds: this.loaded.seconds,
    };
    window.__bench = this.report;
    console.log('CRAFTON_BENCH ' + JSON.stringify(this.report));
    this._show();
    this.active = false;
  }

  _show() {
    const r = this.report, st = r.standing, fl = r.flying;
    const sys = Object.entries(fl.systems).sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 10).map(([n, v]) => `${n.padEnd(12)} ${String(v.perFrameMs.toFixed(2)).padStart(6)} ms/frame   max ${String(v.maxFrameMs).padStart(6)} ms`).join('\n');
    const line = (name, p) => `${name.padEnd(9)} ${String(p.fps).padStart(5)} fps   frame p50 ${p.frameMs.p50} / p95 ${p.frameMs.p95} / p99 ${p.frameMs.p99} / max ${p.frameMs.max} ms   cpu p50 ${p.cpuMs.p50} / p99 ${p.cpuMs.p99} ms   >33 ms: ${p.over33}   >50 ms: ${p.over50}`;
    const text = [
      `CraftOn benchmark — rd ${r.settings.renderDistance}, ${r.resolution}, ${r.renderer}`,
      `loaded in ${r.loading.seconds} s (${r.loading.chunks} chunks${r.loading.complete ? '' : ', timed out'})`,
      line('standing', st), line('flying', fl),
      `longest task ${r.summary.longestTaskMs} ms   longest frame ${r.summary.longestFrameMs} ms   triangles ${fl.triangles.avg} (max ${fl.triangles.max})   draw calls ${fl.drawCalls.avg} (max ${fl.drawCalls.max})   geometry ${r.geometry.megabytes} MB in ${r.geometry.meshes} meshes`,
      `uncapped ≈ ${fl.uncappedFps} fps${fl.uncappedEstimate ? '* (CPU-only estimate)' : ''}   gpu p50 ${fl.gpuMs ? fl.gpuMs.p50 + ' ms' : 'n/a'}   heap allocation ${fl.heapAllocMBps === null ? 'n/a' : fl.heapAllocMBps + ' MB/s'} while flying`,
      '', 'per system (flying):', sys,
    ].join('\n');
    let el = this.panel;
    if (!el) {
      el = document.createElement('pre');
      el.id = 'bench-report';
      document.body.appendChild(el);
      this.panel = el;
    }
    el.textContent = text;
  }
}
