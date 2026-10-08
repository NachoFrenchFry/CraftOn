// ShaderPipeline.js — the optional shader pipeline (Update #9 §4). Off (the default) nothing here touches the
// frame: the chunks keep their MeshBasicMaterial with the baked face shading and the renderer draws the scene
// directly. On, the chunk meshes switch to MeshLambertMaterials patched with onBeforeCompile (same atlas,
// vertex AO, fog and alpha test) that add directional sun light + sky ambient, a sun shadow map snapped to
// texel steps, procedural fancy water, waving plants and leaves and underwater caustics, and a post-process
// chain (PostFX.js) for bloom, god rays, tone mapping, vignette and the underwater wobble. The sun direction is
// Sky.sunDir (no day / night cycle). Everything is client-only; game logic never reads it.
import * as THREE from 'three';
import { AO_BRIGHTNESS, SKY_COLOR } from '../../config/Constants.js';
import { SHADER_PRESETS } from '../../config/DefaultSettings.js';
import { PostFX } from './PostFX.js';
import { LIGHT_UNIFORMS } from '../LightUniforms.js';
import { LIGHT_CURVE_GLSL } from '../../world/lighting/LightCurve.js';

const SUN_DISTANCE = 220;

const FACE_NORMAL_GLSL = `
vec3 craftonFaceNormal(float e) {
  float f = mod(e, 8.0);
  if (f < 0.5) return vec3(1.0, 0.0, 0.0);
  if (f < 1.5) return vec3(-1.0, 0.0, 0.0);
  if (f < 2.5) return vec3(0.0, 1.0, 0.0);
  if (f < 3.5) return vec3(0.0, -1.0, 0.0);
  if (f < 4.5) return vec3(0.0, 0.0, 1.0);
  if (f < 5.5) return vec3(0.0, 0.0, -1.0);
  return vec3(0.0, 1.0, 0.0); // plants and water: lit as if facing up
}`;

const VERTEX_HEAD = `#include <common>
attribute float extra;
attribute float light;
varying float vExtra;
varying float vLight;
varying vec3 vWorldPos;
uniform float uTime;
uniform float uWaving;
uniform float uLighting;
uniform vec4 uAo;
${FACE_NORMAL_GLSL}`;

const VERTEX_BEGIN = `vec3 transformed = vec3(position);
{
  // The fragment gets only the bits that are the same on every vertex of the face (face id, leaves, water): the
  // per-vertex AO level (bits 6-7) and the plant top-wave bit (8) would interpolate into garbage flags.
  float e = extra;
  e -= floor(e / 64.0) * 64.0;
  e -= mod(floor(e / 8.0), 2.0) * 8.0;
  vExtra = e;
}
vLight = light / 240.0;
{
  vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;
  float bits = floor(extra / 8.0);
  float topWave = mod(bits, 2.0);
  float leaves = mod(floor(bits / 2.0), 2.0);
  if (uWaving > 0.5) {
    if (topWave > 0.5) {
      transformed.x += sin(uTime * 1.7 + wp0.x * 0.9 + wp0.z * 1.3) * 0.08;
      transformed.z += cos(uTime * 1.3 + wp0.z * 0.8 + wp0.x * 0.4) * 0.05;
    }
    if (leaves > 0.5) {
      transformed += 0.025 * vec3(sin(uTime * 1.1 + wp0.x * 0.5 + wp0.y * 0.7), sin(uTime * 0.9 + wp0.z * 0.6 + wp0.x * 0.3), cos(uTime * 1.3 + wp0.x * 0.4 + wp0.z * 0.5));
    }
  }
}`;

const VERTEX_COLOR = `#include <color_vertex>
{
  float aoLevel = floor(extra / 64.0);
  float ao = aoLevel < 0.5 ? uAo.x : (aoLevel < 1.5 ? uAo.y : (aoLevel < 2.5 ? uAo.z : uAo.w));
  if (uLighting > 0.5) vColor = vec3(ao); // real light replaces the baked face brightness; AO stays
}`;

const FRAGMENT_HEAD = `#include <common>
varying float vExtra;
varying float vLight;
varying vec3 vWorldPos;
uniform float uTime;
uniform float uWater;
uniform float uUnderwater;
uniform float uLighting;
uniform vec3 uSunDir;
uniform vec3 uSkyColor;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
float craftonSkyTerm = 1.0;
${LIGHT_CURVE_GLSL}`;

/**
 * The lighting model (Update #10 §4b) built on the voxel light, replacing Lambert's direct + indirect sum:
 *   skyTerm = curve(smoothed sky light); sun = max(N·L, 0) × shadow × skyVisibility;
 *   ambient = skyAmbient × skyTerm × (0.55 + 0.35 × hemisphere(N)); colour = albedo × (ambient + sunColour × sun × 0.6) × AO
 * hemisphere: up 1, sides 0.5, down 0.2 (bottoms are dimmer, never black); skyVisibility = smoothstep(10, 15, skyLight)
 * fades direct sun out deep inside caves even where the shadow map would miss. The AO is already in diffuseColor
 * (the vertex colour). With Lighting off the baked face shade × AO × curve is used, like the shaders-off path.
 */
const LIGHT_MODEL = `vec3 outgoingLight;
craftonSkyTerm = craftonLightCurve(vLight);
if (uLighting > 0.5) {
  vec3 nW = normalize(inverseTransformDirection(normal, viewMatrix));
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    shadow = getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize, directionalLightShadows[0].shadowBias, directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
  #endif
  float skyVis = smoothstep(10.0 / 15.0, 1.0, vLight);
  float sun = max(dot(nW, uSunDir), 0.0) * shadow * skyVis;
  float hemi = nW.y >= 0.0 ? mix(0.5, 1.0, nW.y) : mix(0.5, 0.2, -nW.y);
  vec3 ambient = uSkyAmbient * craftonSkyTerm * (0.55 + 0.35 * hemi);
  outgoingLight = diffuseColor.rgb * (ambient + uSunColor * sun * 0.6);
} else {
  outgoingLight = diffuseColor.rgb * craftonSkyTerm;
}`;

const FRAGMENT_TAIL = `#include <dithering_fragment>
{
  float bits = floor(vExtra / 8.0);
  float isWater = mod(floor(bits / 4.0), 2.0);
  float face = mod(vExtra, 8.0);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  if (uWater > 0.5 && isWater > 0.5) {
    // Fancy water: animated procedural waves, Fresnel toward the sky, a sun glint, deeper / flatter views darker and more opaque.
    float w1 = sin(vWorldPos.x * 1.9 + uTime * 1.4) + sin(vWorldPos.z * 2.3 - uTime * 1.1);
    float w2 = sin((vWorldPos.x + vWorldPos.z) * 3.1 + uTime * 2.2) + sin(vWorldPos.x * 4.7 - uTime * 1.9);
    vec3 n = normalize(vec3(w1 * 0.07, 1.0, w2 * 0.05));
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
    vec3 h = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 160.0) * 0.9;
    float flat_ = 1.0 - max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.5, flat_ * 0.55);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uSkyColor * craftonSkyTerm, fres * 0.65) + uSunColor * spec * craftonSkyTerm; // cave water is dark too
    gl_FragColor.a = clamp(gl_FragColor.a + fres * 0.2 + flat_ * 0.15, 0.0, 1.0);
  }
  if (uUnderwater > 0.5 && face > 1.5 && face < 2.5) {
    // Caustic shimmer on upward faces while the camera is under water.
    float c = sin(vWorldPos.x * 3.0 + uTime * 2.1) * sin(vWorldPos.z * 3.3 - uTime * 1.7) + 0.5 * sin((vWorldPos.x - vWorldPos.z) * 5.1 + uTime * 3.0);
    gl_FragColor.rgb += vec3(0.05, 0.07, 0.09) * (0.5 + 0.5 * c);
  }
}`;

export class ShaderPipeline {
  /** @param {import('../../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.settings = game.settings;
    this.enabled = false;
    this.litMaterials = null;
    this.post = null;
    this.time = 0;
    this.shadowScan = 0;
    const sky = new THREE.Color(SKY_COLOR).convertSRGBToLinear();
    this.uniforms = {
      uTime: { value: 0 }, uWaving: { value: 1 }, uLighting: { value: 1 }, uWater: { value: 1 }, uUnderwater: { value: 0 },
      uSunDir: { value: game.sky.sunDir.clone() }, uSkyColor: { value: sky }, uSunColor: { value: new THREE.Color(0xfff2c0).convertSRGBToLinear() },
      uAo: { value: new THREE.Vector4(AO_BRIGHTNESS[0], AO_BRIGHTNESS[1], AO_BRIGHTNESS[2], AO_BRIGHTNESS[3]) },
      uSkyAmbient: { value: new THREE.Color(0xd4e4f4).convertSRGBToLinear() },
      ...LIGHT_UNIFORMS,
    };
    this._right = new THREE.Vector3(); this._up = new THREE.Vector3(); this._tmp = new THREE.Vector3(); this._q = new THREE.Quaternion();
    game.events.on('renderer:resize', (w, h) => { if (this.post) this.post.setSize(w, h); });
  }

  /** The two lights Game added for the character materials: [hemisphere, directional]. */
  get lights() { return this.game.modelLights; }

  /** Read the settings and bring the pipeline in line (called at boot and on every shader setting change). */
  apply() {
    const s = this.settings;
    const on = !!s.get('shadersOn');
    if (on && !this.enabled) this._enable();
    else if (!on && this.enabled) this._disable();
    if (!this.enabled) return;
    const u = this.uniforms;
    u.uWaving.value = s.get('shWaving') ? 1 : 0;
    u.uLighting.value = s.get('shLighting') ? 1 : 0;
    u.uWater.value = s.get('shWater') ? 1 : 0;
    this._applyShadows();
    this._applyPost();
  }

  get preset() { return this.settings.get('shaderPreset'); }

  /** Which preset the current individual options match exactly (or 'custom'). */
  static presetOf(settings) {
    for (const [name, values] of Object.entries(SHADER_PRESETS)) if (Object.entries(values).every(([k, v]) => settings.get(k) === v)) return name;
    return 'custom';
  }

  _enable() {
    const g = this.game, r = g.renderer.renderer;
    this.enabled = true;
    this.litMaterials = this._createLitMaterials(g.atlas.texture);
    g.meshManager.setLitMaterials(this.litMaterials);
    const [hemi, dir] = this.lights;
    hemi.intensity = 0.75;
    dir.intensity = 1.15;
    if (!dir.target.parent) g.renderer.scene.add(dir.target);
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this._markShadowCasters(true);
  }

  _disable() {
    const g = this.game, r = g.renderer.renderer;
    this.enabled = false;
    g.meshManager.setLitMaterials(null);
    if (this.litMaterials) { for (const m of Object.values(this.litMaterials)) m.dispose(); this.litMaterials = null; }
    const [hemi, dir] = this.lights;
    hemi.intensity = 1.1; dir.intensity = 0.9;
    dir.position.set(0.5, 1, 0.3); dir.target.position.set(0, 0, 0); dir.target.updateMatrixWorld();
    dir.castShadow = false;
    if (dir.shadow.map) { dir.shadow.map.dispose(); dir.shadow.map = null; }
    r.shadowMap.enabled = false;
    this._markShadowCasters(false);
    if (this.post) { this.post.dispose(); this.post = null; g.renderer.post = null; }
    if (g.hand && g.hand.lights) g.hand.lights[1].position.set(0.5, 1, 0.3);
    this.uniforms.uUnderwater.value = 0;
  }

  _applyShadows() {
    const s = this.settings, r = this.game.renderer.renderer, dir = this.lights[1];
    const shadows = !!s.get('shShadows');
    const size = s.get('shShadowQuality') | 0, dist = s.get('shShadowDistance');
    if (shadows) {
      if (dir.shadow.mapSize.x !== size) { dir.shadow.mapSize.set(size, size); if (dir.shadow.map) { dir.shadow.map.dispose(); dir.shadow.map = null; } }
      const cam = dir.shadow.camera;
      // Near / far hug the scene: the light sits SUN_DISTANCE from the target; terrain spans the shadow distance around it plus some height.
      const near = Math.max(1, SUN_DISTANCE - dist - 110), far = SUN_DISTANCE + dist + 110;
      if (cam.right !== dist || cam.near !== near || cam.far !== far) { cam.left = -dist; cam.right = dist; cam.top = dist; cam.bottom = -dist; cam.near = near; cam.far = far; cam.updateProjectionMatrix(); }
      // Biases from the texel size (one texel = 2 × distance / map size): about one texel of normal offset and a
      // small constant bias, so shadows touch their casters (Update #10 §4a; 0.6 world units floated them off).
      const texel = (2 * dist) / size;
      dir.shadow.normalBias = texel * 1.2;
      dir.shadow.bias = -0.00012;
      dir.shadow.radius = 1.5;
    } else if (dir.shadow.map) { dir.shadow.map.dispose(); dir.shadow.map = null; }
    dir.castShadow = shadows;
    r.shadowMap.enabled = shadows;
    r.shadowMap.needsUpdate = true;
  }

  _applyPost() {
    const s = this.settings, g = this.game;
    const flags = { bloom: !!s.get('shBloom'), godRays: !!s.get('shGodRays'), toneMap: !!s.get('shToneMap'), vignette: !!s.get('shVignette'), underwater: !!s.get('shUnderwater') };
    const any = flags.bloom || flags.godRays || flags.toneMap || flags.vignette || flags.underwater;
    if (!any) { if (this.post) { this.post.dispose(); this.post = null; g.renderer.post = null; } return; }
    if (!this.post) { this.post = new PostFX(g.renderer); g.renderer.post = this.post; }
    this.post.configure(flags);
  }

  /** Per frame: time, sun light placement with texel snapping, underwater flag, hand light, post uniforms. */
  update(dt) {
    if (!this.enabled) return;
    const g = this.game, cam = g.renderer.camera, sunDir = g.sky.sunDir;
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uSunDir.value.copy(sunDir);
    u.uUnderwater.value = g.player.headInWater && this.settings.get('shUnderwater') ? 1 : 0;
    const dir = this.lights[1];
    // Shadow camera follows the player, snapped to texel-sized steps in light space so shadows do not shimmer.
    const p = g.player.renderPosition;
    const dist = this.settings.get('shShadowDistance'), size = this.settings.get('shShadowQuality') | 0;
    const texel = (2 * dist) / size;
    this._right.set(0, 1, 0).cross(sunDir).normalize();
    this._up.copy(sunDir).cross(this._right).normalize();
    const rx = Math.round(p.dot(this._right) / texel) * texel;
    const ry = Math.round(p.dot(this._up) / texel) * texel;
    const rz = p.dot(sunDir);
    const target = dir.target.position;
    target.copy(this._right).multiplyScalar(rx).addScaledVector(this._up, ry).addScaledVector(sunDir, rz);
    dir.position.copy(target).addScaledVector(sunDir, SUN_DISTANCE);
    dir.target.updateMatrixWorld();
    // The first-person hand gets the sun from the same direction (its scene has its own lights, in view space).
    if (g.hand && g.hand.lights) { this._q.copy(cam.quaternion).invert(); g.hand.lights[1].position.copy(sunDir).applyQuaternion(this._q); }
    // New mobs, players and dropped items cast shadows too: look for new meshes about once a second.
    this.shadowScan -= dt;
    if (this.shadowScan <= 0 && dir.castShadow) { this.shadowScan = 1; this._markShadowCasters(true); }
    if (this.post) this.post.update(this.time, cam, sunDir, g.player.headInWater && this.settings.get('shUnderwater'), g.sky);
  }

  /** castShadow on every character / mob / item mesh (not chunks, sky, particles or overlays). */
  _markShadowCasters(on) {
    const atlas = this.game.atlas.texture;
    this.game.renderer.scene.traverse((o) => {
      if (!o.isMesh || o.name === 'section' || o.userData.noShadow) return;
      const m = o.material;
      if (!m || !(m.isMeshLambertMaterial || (m.isMeshBasicMaterial && m.map === atlas))) return;
      o.castShadow = on;
    });
  }

  _createLitMaterials(atlas) {
    const make = (key, params) => {
      const m = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, fog: true, ...params });
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', VERTEX_HEAD)
          .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = craftonFaceNormal(extra);\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(tangent.xyz);\n#endif')
          .replace('#include <begin_vertex>', VERTEX_BEGIN)
          .replace('#include <color_vertex>', VERTEX_COLOR)
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', FRAGMENT_HEAD)
          .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', LIGHT_MODEL)
          .replace('#include <dithering_fragment>', FRAGMENT_TAIL);
      };
      m.customProgramCacheKey = () => 'crafton-lit-' + key;
      m.shadowSide = THREE.BackSide; // the depth pass draws back faces: no acne without a large bias
      m.name = 'lit-' + key;
      return m;
    };
    return {
      opaque: make('opaque', { side: THREE.FrontSide }),
      cutout: make('cutout', { alphaTest: 0.5, transparent: false, side: THREE.FrontSide }),
      translucent: make('translucent', { transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }),
    };
  }
}
