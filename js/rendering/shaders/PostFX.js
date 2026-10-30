// PostFX.js — the post-process chain of the shader pipeline on Three's EffectComposer, pinned to
// the same Three.js version through the import map ("three/addons/"): RenderPass → god rays (screen-space radial
// blur of the bright sky around the sun, hidden where terrain covers it) → UnrealBloomPass → grade pass (filmic
// ACES tone mapping with a slightly warmer, richer look, vignette, underwater wobble) → OutputPass (sRGB). The
// first-person hand is drawn by Renderer after the chain, so it stays crisp. Built only while some post effect
// is on or FXAA is chosen, and disposed when the last one goes off. Anti-aliasing: with MSAA the chain renders into a
// multisampled WebGLRenderTarget (`samples` 2 or 4; the canvas's own MSAA does not apply inside a composer); FXAA is
// a final pass after the OutputPass (it wants sRGB luma), so it works with or without the shader effects.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

const GOD_RAYS_SHADER = {
  uniforms: { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uIntensity: { value: 0 }, uSunColor: { value: new THREE.Color(1, 0.95, 0.8) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uIntensity; uniform vec3 uSunColor; varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  if (uIntensity <= 0.0) { gl_FragColor = base; return; }
  vec2 delta = (uSun - vUv) / 28.0;
  vec2 uv = vUv; float weight = 0.06; float rays = 0.0;
  for (int i = 0; i < 28; i++) {
    uv += delta;
    vec3 c = texture2D(tDiffuse, uv).rgb;
    float lum = dot(c, vec3(0.3, 0.59, 0.11));
    rays += smoothstep(0.55, 1.1, lum) * weight; // only the bright sky / sun contributes; terrain blocks the shaft
    weight *= 0.95;
  }
  float falloff = 1.0 - smoothstep(0.2, 0.9, distance(vUv, uSun));
  gl_FragColor = vec4(base.rgb + uSunColor * rays * uIntensity * falloff, base.a);
}`,
};

const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null }, uToneMap: { value: 0 }, uVignette: { value: 0 }, uUnderwater: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
uniform sampler2D tDiffuse; uniform float uToneMap; uniform float uVignette; uniform float uUnderwater; uniform float uTime; varying vec2 vUv;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 uv = vUv;
  if (uUnderwater > 0.5) uv += vec2(sin(uv.y * 18.0 + uTime * 2.3), cos(uv.x * 16.0 + uTime * 2.1)) * 0.004;
  vec4 c = texture2D(tDiffuse, uv);
  if (uToneMap > 0.5) {
    vec3 x = c.rgb * vec3(1.06, 1.0, 0.94) * 1.08; // slightly warmer, richer
    float l = dot(x, vec3(0.3, 0.59, 0.11));
    x = mix(vec3(l), x, 1.12);                      // a touch more saturation
    c.rgb = aces(x);
  }
  if (uVignette > 0.5) { float d = length((uv - 0.5) * vec2(1.3, 1.0)); c.rgb *= 1.0 - 0.45 * smoothstep(0.42, 0.95, d); }
  gl_FragColor = c;
}`,
};

export class PostFX {
  /**
   * @param {import('../Renderer.js').Renderer} renderer the game's Renderer wrapper
   * @param {number} samples MSAA samples of the chain's render target (0 = none)
   */
  constructor(renderer, samples = 0) {
    this.wrapper = renderer;
    this.samples = samples;
    const r = renderer.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(r, target);
    this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.setSize(renderer.width, renderer.height);
    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaaOn = false;
    this._fxaaResolution(renderer.width, renderer.height);
    this.renderPass = new RenderPass(renderer.scene, renderer.camera);
    this.godRays = new ShaderPass(GOD_RAYS_SHADER);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(renderer.width, renderer.height), 0.45, 0.35, 0.82);
    this.grade = new ShaderPass(GRADE_SHADER);
    this.output = new OutputPass();
    this.flags = null;
    this._v = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /** Rebuild the pass list for the enabled effects (cheap: the passes already exist); `fxaa` adds the FXAA pass at the end. */
  configure(flags, fxaa = false) {
    this.flags = flags || { bloom: false, godRays: false, toneMap: false, vignette: false, underwater: false };
    flags = this.flags;
    this.fxaaOn = !!fxaa;
    const c = this.composer;
    c.passes.length = 0;
    c.addPass(this.renderPass);
    if (flags.godRays) c.addPass(this.godRays);
    if (flags.bloom) c.addPass(this.bloom);
    if (flags.toneMap || flags.vignette || flags.underwater) c.addPass(this.grade);
    c.addPass(this.output);
    if (this.fxaaOn) c.addPass(this.fxaa);
    this.grade.uniforms.uToneMap.value = flags.toneMap ? 1 : 0;
    this.grade.uniforms.uVignette.value = flags.vignette ? 1 : 0;
  }

  /** Whether any of the shader effects is on (the chain may exist for FXAA alone). */
  get anyEffect() { const f = this.flags; return !!f && (f.bloom || f.godRays || f.toneMap || f.vignette || f.underwater); }

  setSize(w, h) {
    this.composer.setPixelRatio(this.wrapper.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this._fxaaResolution(w, h);
  }
  _fxaaResolution(w, h) { const pr = this.wrapper.renderer.getPixelRatio(); this.fxaa.material.uniforms.resolution.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr)); }

  /** Per frame: sun screen position for the god rays, underwater wobble, time. */
  update(time, camera, sunDir, underwater, sky) {
    const f = this.flags;
    if (!f) return;
    this.grade.uniforms.uTime.value = time;
    this.grade.uniforms.uUnderwater.value = f.underwater && underwater ? 1 : 0;
    if (f.godRays) {
      camera.getWorldDirection(this._fwd);
      const facing = this._fwd.dot(sunDir);
      if (facing > 0.05 && !underwater) {
        this._v.copy(camera.position).addScaledVector(sunDir, 400).project(camera);
        this.godRays.uniforms.uSun.value.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5);
        this.godRays.uniforms.uIntensity.value = Math.min(1, (facing - 0.05) * 2.5) * 0.9;
        this.godRays.uniforms.uSunColor.value.copy(sky.baseColors.sun).convertSRGBToLinear();
      } else this.godRays.uniforms.uIntensity.value = 0;
    }
  }

  render() { this.composer.render(); }

  dispose() {
    this.composer.passes.length = 0;
    this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose();
    this.bloom.dispose();
    this.godRays.dispose(); this.grade.dispose(); this.output.dispose(); this.fxaa.dispose();
  }
}
