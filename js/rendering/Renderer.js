// Renderer.js — WebGLRenderer setup, responsive resizing (window, ResizeObserver, DPR changes), anti-aliasing and
// the two-pass render (world, then the first-person hand overlay on a cleared depth buffer). The colour grade ("tone
// mapping & color", Grade.js) is always on: it is Three's CustomToneMapping, so on the DIRECT path every material grades
// itself while drawing to the canvas and the canvas's own MSAA applies. The post chain (PostFX, Three's EffectComposer)
// is owned here and only RUNS when a frame needs it: bloom or god rays, FXAA, or the underwater wobble while the head is
// in a liquid; it is built ahead of time whenever any of those is on (no hitch on the first dive) and its render target
// is never multisampled — with an MSAA setting the FXAA pass stands in for the chain's frames. Anti-aliasing follows the
// "antialias" setting: MSAA is a property of the WebGL context (antialias: true at creation, so a change between MSAA
// and no MSAA applies after a reload), FXAA is a live post pass, used as the fallback when the browser gives no
// multisampled context.

import * as THREE from 'three';
import { GpuTimer, uncappedFps } from './GpuTimer.js';
import { HAND_FOV } from '../config/Constants.js';
import { PostFX } from './shaders/PostFX.js';
import { CUSTOM_TONE_MAPPING_STUB, CUSTOM_TONE_MAPPING_GLSL, gradeColor } from './shaders/Grade.js';
import { FOG_RAW_UNIFORM } from './Materials.js';

// Before any material compiles: Three's CustomToneMapping becomes the game's grade (the stub returns its input).
if (THREE.ShaderChunk.tonemapping_pars_fragment.includes(CUSTOM_TONE_MAPPING_STUB)) {
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(CUSTOM_TONE_MAPPING_STUB, CUSTOM_TONE_MAPPING_GLSL);
} else if (!THREE.ShaderChunk.tonemapping_pars_fragment.includes('craftonGrade')) {
  console.warn('Renderer: Three\'s CustomToneMapping stub was not found; the colour grade is appended instead');
  THREE.ShaderChunk.tonemapping_pars_fragment += '\n' + CUSTOM_TONE_MAPPING_GLSL;
}

/** The MSAA samples a setting value asks for (0 = none). */
export function msaaSamplesOf(mode) { return mode === 'msaa4' ? 4 : mode === 'msaa2' ? 2 : 0; }

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
    const aa = String(settings.get('antialias') || 'off');
    const wantMsaa = msaaSamplesOf(aa) > 0;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: wantMsaa, powerPreference: 'high-performance', alpha: false });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The grade applies wherever Three tone-maps: materials drawn straight to the canvas (never inside a render target, so
    // the post chain's RenderPass stays raw and the chain's own grade pass cannot double it).
    this.renderer.toneMapping = THREE.CustomToneMapping;
    let attrs = null;
    try { attrs = this.renderer.getContext().getContextAttributes(); } catch (e) { /* no attributes: treat as no MSAA */ }
    /** The context was created multisampled (the canvas itself is anti-aliased whenever no post chain draws). */
    this.contextMsaa = !!(attrs && attrs.antialias);
    /** MSAA was asked for and the browser refused it: FXAA stands in. */
    this.msaaUnsupported = wantMsaa && !this.contextMsaa;
    if (this.msaaUnsupported) console.warn('Renderer: the browser gave no multisampled context; FXAA is used instead of MSAA');
    globalThis.__craftonMsaa = this.contextMsaa ? 'on' : 'off'; // the options screen warns when the setting needs a reload
    /** The effective anti-aliasing: 'off' | 'fxaa' | 'msaa2' | 'msaa4'. */
    this.aaMode = 'off';
    /** The shader pipeline's post-effect flags (null = none). */
    this.postFlags = null;
    this._aaSetting = aa;
    /** GPU frame time (WebGL2 timer queries; `available` false means CPU-only estimates). */
    this.gpuTimer = new GpuTimer(this.renderer.getContext());
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.05, 1000);
    this.setRenderDistance(settings.get('renderDistance'));
    this.handScene = new THREE.Scene();
    this.handCamera = new THREE.PerspectiveCamera(HAND_FOV, 1, 0.01, 10);
    this.width = 1;
    this.height = 1;
    this.handVisible = false;
    /** The post-process chain (PostFX) while bloom, god rays, the underwater wobble or FXAA is on, else null. */
    this.post = null;
    /** Set by Game each frame: the camera's head is in water or lava (the underwater wobble runs the chain only then). */
    this.liquidView = false;
    /** Whether the last frame went through the post chain (false = straight to the canvas with its own MSAA). */
    this.chainActive = false;
    this._fogColor = new THREE.Color();
    this._gradedFog = new THREE.Color();
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
    this.setAntialias(aa);
  }

  /**
   * Apply an anti-aliasing setting value live: FXAA and Off switch at once; MSAA needs the context to have been created
   * multisampled (else the setting waits for a reload, or FXAA stands in when the browser cannot multisample at all).
   */
  setAntialias(mode) {
    this._aaSetting = mode = String(mode || 'off');
    const samples = msaaSamplesOf(mode);
    if (samples > 0) this.aaMode = this.contextMsaa ? mode : this.msaaUnsupported ? 'fxaa' : 'off';
    else this.aaMode = mode === 'fxaa' ? 'fxaa' : 'off';
    this._rebuildPost();
  }
  /** The setting asks for an MSAA state the context does not have: a reload applies it. */
  get aaNeedsReload() { return !this.msaaUnsupported && (msaaSamplesOf(this._aaSetting) > 0) !== this.contextMsaa; }

  /** The shader pipeline's post-effect flags (null when every effect is off); rebuilds the chain. */
  setPostFlags(flags) { this.postFlags = flags; this._rebuildPost(); }
  /**
   * The chain exists while bloom, god rays, the underwater wobble or FXAA is on. Its target is never multisampled: when
   * the player's setting is MSAA, the FXAA pass smooths the frames that go through the chain (the direct frames keep the
   * canvas's MSAA). Built ahead of time (and its material variants compiled) so the first dive never hitches.
   */
  _rebuildPost() {
    const fxaa = this.aaMode === 'fxaa';
    const need = !!this.postFlags || fxaa;
    if (!need) { if (this.post) { this.post.dispose(); this.post = null; } return; }
    const fresh = !this.post;
    if (fresh) { this.post = new PostFX(this); this.post.setSize(this.width, this.height); }
    this.post.configure(this.postFlags, fxaa || msaaSamplesOf(this.aaMode) > 0, fxaa);
    if (fresh) this._precompileChain();
  }

  /**
   * Materials get a second program variant inside a render target (no tone mapping, linear output), so the scene is
   * compiled once against the chain's target when the chain appears — not on the first underwater frame.
   */
  _precompileChain() {
    const r = this.renderer, target = this.post && this.post.composer.renderTarget1;
    if (!target || typeof r.compile !== 'function') return;
    try { r.setRenderTarget(target); r.compile(this.scene, this.camera); } catch (e) { /* a material that cannot compile shows up on its first use instead */ }
    r.setRenderTarget(null);
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
    if (this.post) this.post.setSize(w, h);
    this.events.emit('renderer:resize', w, h);
  }

  /** The far plane follows the render distance: 32 chunks reach 512 blocks, plus the chunk diagonal and the sky dome's room. */
  setRenderDistance(chunks) {
    const far = Math.max(600, (chunks | 0) * 16 * 1.5 + 64);
    if (this.camera.far !== far) { this.camera.far = far; this.camera.updateProjectionMatrix(); }
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
    const chain = !!this.post && this.post.needsChain(this.liquidView);
    this.chainActive = chain;
    const fog = this.scene.fog;
    if (fog) FOG_RAW_UNIFORM.value.copy(fog.color); // the chunk shaders mix this raw colour in linear space before the grade (Materials.js)
    if (chain) { if (this.profiler) this.profiler.begin('post'); this.post.render(); if (this.profiler) this.profiler.end('post'); }
    else {
      // Direct to the canvas: every material grades itself (CustomToneMapping). Three's own materials (mobs, items, the hand)
      // mix the fog in after that and after the sRGB encode, so the scene's fog colour is handed over graded and encoded —
      // they fade to the colour the graded sky dome shows (underwater and lava fog included), with no band at the horizon.
      if (fog) { this._fogColor.copy(fog.color); fog.color.copy(gradeColor(this._fogColor, this._gradedFog)); }
      r.render(this.scene, this.camera);
      if (fog) fog.color.copy(this._fogColor);
    }
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
