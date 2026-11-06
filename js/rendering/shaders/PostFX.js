// PostFX.js — the post-process chain of the shader pipeline on Three's EffectComposer, pinned to
// the same Three.js version through the import map ("three/addons/"): RenderPass → god rays (screen-space radial
// blur of the bright sky around the sun, hidden where terrain covers it) → UnrealBloomPass → grade pass (the game's
// colour grade from Grade.js — Three never tone-maps inside a render target, so the chain applies it here — plus the
// underwater wobble) → OutputPass (sRGB). The first-person hand is drawn by Renderer after the chain, so it stays
// crisp. The chain is built while bloom, god rays, the underwater wobble or FXAA is on, but it only RUNS for bloom, god
// rays, FXAA, or the wobble while the head is actually in a liquid (`needsChain`); every other frame goes straight to
// the canvas, graded by the materials themselves. The render target is never multisampled (that was the single biggest
// cost): with an MSAA setting the FXAA pass smooths the frames that go through the chain. FXAA is a final pass after
// the OutputPass (it wants sRGB luma). The vignette is a CSS overlay (css/hud.css #vignette-overlay), not a pass.
import * as THREE from 'three';
import { GRADE_GLSL } from './Grade.js';
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
  uniforms: { tDiffuse: { value: null }, uUnderwater: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
uniform sampler2D tDiffuse; uniform float uUnderwater; uniform float uTime; varying vec2 vUv;
${GRADE_GLSL}
void main() {
  vec2 uv = vUv;
  if (uUnderwater > 0.5) uv += vec2(sin(uv.y * 18.0 + uTime * 2.3), cos(uv.x * 16.0 + uTime * 2.1)) * 0.004;
  vec4 c = texture2D(tDiffuse, uv);
  c.rgb = craftonGrade(c.rgb); // always: the same grade the materials apply on the direct path
  gl_FragColor = c;
}`,
};

export class PostFX {
  /** @param {import('../Renderer.js').Renderer} renderer the game's Renderer wrapper */
  constructor(renderer) {
    this.wrapper = renderer;
    const r = renderer.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 }); // never multisampled
    this.composer = new EffectComposer(r, target);
    this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.setSize(renderer.width, renderer.height);
    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaaOn = false;
    /** FXAA was chosen as the anti-aliasing itself (the chain runs for it); false when it only stands in for MSAA on chain frames. */
    this.fxaaWanted = false;
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

  /**
   * Rebuild the pass list for the enabled effects (cheap: the passes already exist). `fxaa` adds the FXAA pass at the end
   * (chosen as the anti-aliasing, or standing in for MSAA on the chain's frames); `fxaaWanted` says the chain must run for it.
   */
  configure(flags, fxaa = false, fxaaWanted = fxaa) {
    this.flags = flags || { bloom: false, godRays: false, underwater: false };
    flags = this.flags;
    this.fxaaOn = !!fxaa;
    this.fxaaWanted = !!fxaaWanted;
    const c = this.composer;
    c.passes.length = 0;
    c.addPass(this.renderPass);
    if (flags.godRays) c.addPass(this.godRays);
    if (flags.bloom) c.addPass(this.bloom);
    c.addPass(this.grade); // the grade (Three does not tone-map into render targets) and, under water, the wobble
    c.addPass(this.output);
    if (this.fxaaOn) c.addPass(this.fxaa);
  }

  /** Whether any of the shader effects is on (the chain may exist for FXAA alone). */
  get anyEffect() { const f = this.flags; return !!f && (f.bloom || f.godRays || f.underwater); }
  /** Whether the chain runs every frame regardless of liquids: bloom, god rays, or FXAA chosen as the anti-aliasing. */
  get alwaysOn() { const f = this.flags; return this.fxaaWanted || !!(f && (f.bloom || f.godRays)); }
  /** Whether this frame has to go through the chain (`liquidView`: the head is in water or lava). */
  needsChain(liquidView) { return this.alwaysOn || !!(this.flags && this.flags.underwater && liquidView); }

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
    if (this.wrapper.renderer.getRenderTarget() === this.composer.renderTarget1) this.wrapper.renderer.setRenderTarget(null);
    this.bloom.dispose();
    this.godRays.dispose(); this.grade.dispose(); this.output.dispose(); this.fxaa.dispose();
  }
}
