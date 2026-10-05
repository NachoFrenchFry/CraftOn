// Renderer.js — WebGLRenderer setup, responsive resizing (window, ResizeObserver, DPR changes) and
// the two-pass render (world, then the first-person hand overlay on a cleared depth buffer).

import * as THREE from 'three';
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
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.05, 1000);
    this.handScene = new THREE.Scene();
    this.handCamera = new THREE.PerspectiveCamera(HAND_FOV, 1, 0.01, 10);
    this.width = 1;
    this.height = 1;
    this.handVisible = false;
    /** Draw calls / triangles of the world pass (renderer.info resets per render call). */
    this.worldStats = { calls: 0, triangles: 0 };
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

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    const scale = this.settings.get('renderScale');
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * scale);
    this.renderer.setSize(w, h, false);
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

  render() {
    const r = this.renderer;
    r.clear();
    r.render(this.scene, this.camera);
    this.worldStats.calls = r.info.render.calls;
    this.worldStats.triangles = r.info.render.triangles;
    if (this.handVisible) {
      r.clearDepth();
      r.render(this.handScene, this.handCamera);
    }
  }

  get info() { return this.renderer.info; }
}
