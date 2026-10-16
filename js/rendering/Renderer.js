// Renderer.js — WebGLRenderer setup, responsive resizing (window, ResizeObserver, DPR changes) and
// the two-pass render (world, then the first-person hand overlay on a cleared depth buffer).

import * as THREE from 'three';
import { GpuTimer, uncappedFps } from './GpuTimer.js';
import { HAND_FOV } from '../config/Constants.js';

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../core/EventBus.js').EventBus} events
   */
  constructor(canvas, settings, events) {
    this.canvas = canvas;
    this.settings = settings;
    this.events = events;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    /** GPU frame time (WebGL2 timer queries; `available` false means CPU-only estimates). */
    this.gpuTimer = new GpuTimer(this.renderer.getContext());
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.05, 1000);
    this.handScene = new THREE.Scene();
    this.handCamera = new THREE.PerspectiveCamera(HAND_FOV, 1, 0.01, 10);
    this.width = 1;
    this.height = 1;
    this.handVisible = false;
    /** Post-process chain of the shader pipeline (PostFX) while any post effect is on, else null. */
    this.post = null;
    /** Draw calls / triangles of the world pass (renderer.info resets per render call). */
    this.worldStats = { calls: 0, triangles: 0 };
    /** Render scale picked by the Auto mode (PerformanceMonitor lowers it while the FPS stays under the target). */
    this.autoScale = 1;
    /** Fixed internal resolution ({ w, h }) for the benchmark; null = the window size × DPR × scale. */
    this.fixedSize = null;
    /** Set by Game: the post-effect chain is timed apart from the world pass. */
    this.profiler = null;
    this._dprQuery = null;
    this._bindResize();
    this.resize();
  }

  _bindResize() {
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(document.body);
    }
    this._watchDpr();
  }

  /** Re-arm a matchMedia listener for the current DPR so zoom / monitor moves trigger a resize. */
  _watchDpr() {
    if (this._dprQuery) this._dprQuery.removeEventListener('change', this._dprHandler);
    this._dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this._dprHandler = () => { this.resize(); this._watchDpr(); };
    this._dprQuery.addEventListener('change', this._dprHandler);
  }

  /** The render scale in use: the setting, or the Auto mode's current pick. The canvas CSS upscales it pixelated. */
  get renderScale() { const s = this.settings.get('renderScale'); return s > 0 ? s : this.autoScale; }

  setAutoScale(scale) {
    if (scale === this.autoScale) return;
    this.autoScale = scale;
    this.resize();
  }

  setFixedSize(w, h) { this.fixedSize = w && h ? { w, h } : null; this.resize(); }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    const scale = this.renderScale;
    if (this.fixedSize) { this.renderer.setPixelRatio(1); this.renderer.setSize(this.fixedSize.w, this.fixedSize.h, false); }
    else {
      // HiDPI off (the default): one internal pixel per CSS pixel, whatever the screen's ratio.
      const dpr = this.settings.get('hiDpi') ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      this.renderer.setPixelRatio(dpr * scale); this.renderer.setSize(w, h, false);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.handCamera.aspect = w / h;
    this.handCamera.updateProjectionMatrix();
    this.events.emit('renderer:resize', w, h);
  }

  setFov(fov) {
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The frame rate the game could reach without the display's refresh cap: { fps, estimate } (estimate = no GPU timer). */
  uncapped(cpuMs) { return uncappedFps(cpuMs, this.gpuTimer.available ? this.gpuTimer.avgMs : 0); }

  /**
   * Compile the shader programs of these materials now (one dummy mesh each in a scratch scene, lit by the real scene's
   * lights), so the first lava, torch, water or lit frame never hitches on a compile. Resolves when done.
   */
  /**
   * Compile every material in `materials` now (a scratch scene of one dummy mesh per material, lights and fog from the real
   * scene) and resolve once their programs are usable. Three's compileAsync is not used: it polls `program.isReady()` on
   * every material until all are ready and throws when one was disposed meanwhile (shaders toggled off during the wait).
   */
  async precompile(materials) {
    const list = (materials || []).filter((m) => m && m.isMaterial);
    const r = this.renderer;
    if (!list.length || typeof r.compile !== 'function') return 0;
    const scratch = new THREE.Scene();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    for (const m of list) { const mesh = new THREE.Mesh(geom, m); mesh.frustumCulled = false; scratch.add(mesh); }
    let compiled = null;
    try { compiled = r.compile(scratch, this.camera, this.scene); } catch (e) { /* a material that cannot compile shows up on its first use instead */ }
    geom.dispose();
    if (!compiled || !r.properties) return list.length;
    // KHR_parallel_shader_compile: wait (at most ~2 s) until every program reports ready; a disposed material simply drops out.
    const t0 = performance.now();
    await new Promise((resolve) => {
      const check = () => {
        let pending = 0;
        for (const m of compiled) {
          const program = r.properties.get(m).currentProgram;
          if (program && typeof program.isReady === 'function' && !program.isReady()) pending++;
        }
        if (pending === 0 || performance.now() - t0 > 2000) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
    return list.length;
  }

  render() {
    const r = this.renderer;
    this.gpuTimer.poll();
    this.gpuTimer.begin();
    r.clear();
    if (this.post) { if (this.profiler) this.profiler.begin('post'); this.post.render(); if (this.profiler) this.profiler.end('post'); } else r.render(this.scene, this.camera);
    this.worldStats.calls = r.info.render.calls;
    this.worldStats.triangles = r.info.render.triangles;
    if (this.handVisible) {
      r.clearDepth();
      r.render(this.handScene, this.handCamera);
    }
    this.gpuTimer.end();
  }

  get info() { return this.renderer.info; }
}
