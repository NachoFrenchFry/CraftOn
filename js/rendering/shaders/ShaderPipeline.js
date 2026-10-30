// ShaderPipeline.js — the optional shader pipeline. Off (the default) nothing here touches the
// frame: the chunks keep their MeshBasicMaterial with the baked face shading and the renderer draws the scene
// directly. On, the chunk meshes switch to MeshLambertMaterials patched with onBeforeCompile (same atlas,
// vertex AO, fog and alpha test) that add directional sun light + sky ambient, sun shadows from two cascades
// snapped to texel steps (a near one for tight contact shadows, the far one for distance), procedural fancy
// water, waving plants and leaves and underwater caustics, and a post-process
// chain (PostFX.js) for bloom, god rays, tone mapping, vignette and the underwater wobble. The sun direction is
// Sky.sunDir (no day / night cycle). Everything is client-only; game logic never reads it.
import * as THREE from 'three';
import { PACKED_VERTEX_GLSL } from '../PackedVertex.js';
import { createChunkMaterial, chunkPassDefines } from '../Materials.js';
import { AO_BRIGHTNESS, SKY_COLOR } from '../../config/Constants.js';
import { SHADER_PRESETS } from '../../config/DefaultSettings.js';
import { LIGHT_UNIFORMS } from '../LightUniforms.js';
import { LIGHT_CURVE_GLSL } from '../../world/lighting/LightCurve.js';

const SUN_DISTANCE = 220;
/** The near cascade: a 40-block box (half-extent) around the player on a map of at least 2048 px, for sharp contact shadows. */
const NEAR_SHADOW_DISTANCE = 20;
const NEAR_SHADOW_MIN_SIZE = 2048;
/**
 * Normal offset in texels (tiny). The chunk depth pass draws the FRONT faces (the ones facing the sun): chunk meshes are
 * not closed — hidden faces are culled, so a block on the ground has no bottom face and the ground under it has no top
 * face — and a back-face depth pass therefore stores no surface at all where a block meets the floor, which leaves a lit
 * strip about one texel ÷ sin(sun elevation) wide along every shaded base. With front faces the floor's own depth is in
 * the map, so the slope-scaled bias in the fragment shader plus this small offset keep it acne-free.
 */
const NORMAL_OFFSET_TEXELS = 0.25;

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
${PACKED_VERTEX_GLSL}
varying float vExtra;
varying vec2 vLight;
varying vec3 vWorldPos;
uniform float uTime;
uniform float uWaving;
uniform float uLighting;
uniform vec4 uAo;
${FACE_NORMAL_GLSL}`;

/** Waving plants and leaves, shared by the colour pass and the shadow depth pass (so shadows wave with their casters). */
const WAVE_GLSL = `{
  vec3 wp0 = (modelMatrix * vec4(cv.pos, 1.0)).xyz;
  float topWave = cv.topWave;
  float leaves = cv.leaves;
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

/** Decodes the packed vertex (in place of Three's uv_vertex, the first include in main) and feeds the map coordinates. */
const VERTEX_UV = `CraftonVertex cv = craftonDecode();
#ifdef USE_MAP
vMapUv = cv.uv;
#endif
vTile = cv.tile;`;

const VERTEX_BEGIN = `vec3 transformed = cv.pos;
// The fragment gets only the bits that are the same on every vertex of the face (face id, leaves, water): the
// per-vertex AO level and the plant top-wave bit would interpolate into garbage flags.
vExtra = cv.face + cv.leaves * 16.0 + cv.water * 32.0;
vLight = cv.light;
${WAVE_GLSL}`;

/** The shadow depth pass for chunks: the same decode and waving, the alpha test from the tile array (leaves, plants, glass). */
const DEPTH_VERTEX_HEAD = `#include <common>
${PACKED_VERTEX_GLSL}
varying float vTile;
uniform float uTime;
uniform float uWaving;`;
const DEPTH_VERTEX_BEGIN = `vec3 transformed = cv.pos;
${WAVE_GLSL}`;

/**
 * Shadow lookup with a 3×3 PCF and a slope-scaled bias in light space: `bias` is the depth of one texel's worth of
 * world travel scaled by the receiver's slope toward the light (computed by the caller from the flat face normal), so
 * steep faces and double-sided leaves never acne while flat floors keep their shadows right up to the caster.
 */
const SHADOW_GLSL = `#include <shadowmap_pars_fragment>
#ifdef USE_SHADOWMAP
float craftonShadow(sampler2D map, vec2 mapSize, vec3 c, float bias) {
  if (c.z > 1.0 || c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) return 1.0;
  float compare = c.z - bias;
  vec2 texel = 1.0 / mapSize;
  float sum = 0.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) sum += texture2DCompare(map, c.xy + vec2(float(dx), float(dy)) * texel, compare);
  return sum / 9.0;
}
#endif`;

const VERTEX_COLOR = `vColor = vec3(cv.shade);
{
  float aoLevel = cv.ao;
  float ao = aoLevel < 0.5 ? uAo.x : (aoLevel < 1.5 ? uAo.y : (aoLevel < 2.5 ? uAo.z : uAo.w));
  if (uLighting > 0.5) vColor = vec3(ao); // real light replaces the baked face brightness; AO stays
}`;

const FRAGMENT_HEAD = `#include <common>
varying float vExtra;
varying vec2 vLight;
varying vec3 vWorldPos;
uniform float uTime;
uniform float uWater;
uniform float uUnderwater;
uniform float uLighting;
uniform vec3 uSunDir;
uniform vec3 uSkyColor;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform float uNearShadow;
uniform float uShadowSlope;
uniform float uNearSlope;
float craftonSkyTerm = 1.0;
${LIGHT_CURVE_GLSL}`;

/**
 * The lighting model built on the voxel light, replacing Lambert's direct + indirect sum:
 *   skyTerm = curve(smoothed sky light); sun = max(N·L, 0) × shadow × skyVisibility;
 *   ambient = skyAmbient × skyTerm × (0.55 + 0.35 × hemisphere(N)); colour = albedo × (ambient + sunColour × sun × 0.6) × AO
 * hemisphere: up 1, sides 0.5, down 0.2 (bottoms are dimmer, never black); skyVisibility = smoothstep(10, 15, skyLight)
 * fades direct sun out deep inside caves even where the shadow map would miss. The AO is already in diffuseColor
 * (the vertex colour). With Lighting off the baked face shade × AO × curve is used, like the shaders-off path.
 */
const LIGHT_MODEL = `vec3 outgoingLight;
craftonSkyTerm = craftonLightCurve(vLight.x);
vec3 craftonBlockTerm = craftonLightCurve(vLight.y) * craftonWarm; // torches / lava: warm, unshadowed, visible deep in caves
if (uLighting > 0.5) {
  vec3 nW = normalize(inverseTransformDirection(normal, viewMatrix));
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    // Two cascades: the near map (index 1) wherever the fragment falls inside it, else the far map (index 0).
    float ndl = max(dot(nW, uSunDir), 0.05);
    float tanTheta = min(sqrt(max(1.0 - ndl * ndl, 0.0)) / ndl, 8.0);
    float slope = 0.5 + 1.5 * tanTheta;
    bool nearDone = false;
    #if NUM_DIR_LIGHT_SHADOWS > 1
      if (uNearShadow > 0.5) {
        vec3 cn = vDirectionalShadowCoord[1].xyz / vDirectionalShadowCoord[1].w;
        if (cn.x > 0.02 && cn.x < 0.98 && cn.y > 0.02 && cn.y < 0.98 && cn.z < 1.0) { shadow = craftonShadow(directionalShadowMap[1], directionalLightShadows[1].shadowMapSize, cn, uNearSlope * slope); nearDone = true; }
      }
    #endif
    if (!nearDone) { vec3 cf = vDirectionalShadowCoord[0].xyz / vDirectionalShadowCoord[0].w; shadow = craftonShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize, cf, uShadowSlope * slope); }
  #endif
  float skyVis = smoothstep(10.0 / 15.0, 1.0, vLight.x);
  float sun = max(dot(nW, uSunDir), 0.0) * shadow * skyVis;
  float hemi = nW.y >= 0.0 ? mix(0.5, 1.0, nW.y) : mix(0.5, 0.2, -nW.y);
  vec3 ambient = uSkyAmbient * craftonSkyTerm * (0.55 + 0.35 * hemi);
  outgoingLight = diffuseColor.rgb * max(ambient + uSunColor * sun * 0.6, craftonBlockTerm);
} else {
  outgoingLight = diffuseColor.rgb * max(vec3(craftonSkyTerm), craftonBlockTerm);
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
    // the sky reflection and the sun glint only where the surface sees the sky (the terrain's
    // skyVisibility term); underground the water reflects the dark cave, warmed by nearby torches or lava.
    float skyVis = smoothstep(10.0 / 15.0, 1.0, vLight.x);
    vec3 caveReflect = vec3(0.02, 0.025, 0.03) + craftonLightCurve(vLight.y) * craftonWarm * 0.25;
    vec3 reflectColor = mix(caveReflect, uSkyColor * craftonSkyTerm, skyVis);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, reflectColor, fres * 0.65) + uSunColor * spec * craftonSkyTerm * skyVis;
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
      uNearShadow: { value: 0 }, uShadowSlope: { value: 0 }, uNearSlope: { value: 0 },
      ...LIGHT_UNIFORMS,
    };
    /** The near cascade: a second directional light with no diffuse contribution (intensity 0), only a shadow map. */
    this.nearLight = null;
    /** Shadow update policy: the maps re-render only when a cascade snapped, chunk geometry changed or something moves inside the box. */
    this._lastGeometryVersion = -1;
    this._frame = 0;
    this._casters = -1;
    this._right = new THREE.Vector3(); this._up = new THREE.Vector3(); this._tmp = new THREE.Vector3(); this._q = new THREE.Quaternion();
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
    this.litMaterials = this._createLitMaterials(g.atlas);
    g.meshManager.setLitMaterials(this.litMaterials);
    const [hemi, dir] = this.lights;
    hemi.intensity = 0.75;
    dir.intensity = 1.15;
    if (!dir.target.parent) g.renderer.scene.add(dir.target);
    if (!this.nearLight) { this.nearLight = new THREE.DirectionalLight(0xffffff, 0); this.nearLight.name = 'near-shadow'; }
    g.renderer.scene.add(this.nearLight); // after the sun light, so it is shadow index 1
    g.renderer.scene.add(this.nearLight.target);
    r.shadowMap.type = THREE.PCFShadowMap; // the chunk shader does its own 3×3 PCF; characters use Three's
    // The sun is fixed and the terrain mostly static: each cascade re-renders only when update() says so.
    dir.shadow.autoUpdate = false; dir.shadow.needsUpdate = true;
    this.nearLight.shadow.autoUpdate = false; this.nearLight.shadow.needsUpdate = true;
    this._lastGeometryVersion = -1;
    this._markShadowCasters(true);
    if (g.renderer.precompile) g.renderer.precompile(this.allMaterials()); // no hitch on the first lit frame
  }

  /** Every material the lit path can use (for shader precompilation). */
  allMaterials() {
    const out = [];
    if (this.litMaterials) for (const m of Object.values(this.litMaterials)) { if (m.isMaterial) out.push(m); else out.push(...Object.values(m)); }
    return out;
  }

  _disable() {
    const g = this.game, r = g.renderer.renderer;
    this.enabled = false;
    g.meshManager.setLitMaterials(null);
    if (this.litMaterials) { for (const m of Object.values(this.litMaterials)) { if (m.isMaterial) m.dispose(); else for (const d of Object.values(m)) d.dispose(); } this.litMaterials = null; }
    const [hemi, dir] = this.lights;
    hemi.intensity = 1.1; dir.intensity = 0.9;
    dir.position.set(0.5, 1, 0.3); dir.target.position.set(0, 0, 0); dir.target.updateMatrixWorld();
    dir.castShadow = false;
    dir.shadow.autoUpdate = true;
    if (dir.shadow.map) { dir.shadow.map.dispose(); dir.shadow.map = null; }
    if (this.nearLight) {
      this.nearLight.castShadow = false;
      if (this.nearLight.shadow.map) { this.nearLight.shadow.map.dispose(); this.nearLight.shadow.map = null; }
      g.renderer.scene.remove(this.nearLight); g.renderer.scene.remove(this.nearLight.target);
    }
    this.uniforms.uNearShadow.value = 0;
    r.shadowMap.enabled = false;
    this._markShadowCasters(false);
    if (this.post) { this.post = null; g.renderer.setPostFlags(null); }
    if (g.hand && g.hand.lights) g.hand.lights[1].position.set(0.5, 1, 0.3);
    this.uniforms.uUnderwater.value = 0;
  }

  /**
   * One cascade's shadow camera: an orthographic box of half-extent `dist` around the target with near / far hugging the
   * scene (the light sits SUN_DISTANCE from the target; terrain spans the box plus some height), a normal offset of
   * NORMAL_OFFSET_TEXELS and no constant bias (the depth pass draws the sun-facing faces and the fragment shader adds a slope-scaled
   * bias). Returns the depth of one world texel in light-space depth units for that slope bias.
   */
  _setupCascade(light, dist, size) {
    if (light.shadow.mapSize.x !== size) { light.shadow.mapSize.set(size, size); if (light.shadow.map) { light.shadow.map.dispose(); light.shadow.map = null; } }
    const cam = light.shadow.camera;
    const near = Math.max(1, SUN_DISTANCE - dist - 110), far = SUN_DISTANCE + dist + 110;
    if (cam.right !== dist || cam.near !== near || cam.far !== far) { cam.left = -dist; cam.right = dist; cam.top = dist; cam.bottom = -dist; cam.near = near; cam.far = far; cam.updateProjectionMatrix(); }
    const texel = (2 * dist) / size;
    light.shadow.normalBias = texel * NORMAL_OFFSET_TEXELS;
    light.shadow.bias = 0;
    light.shadow.radius = 1;
    return texel / (far - near);
  }

  /** The near cascade's box and map size for the current quality setting. */
  static nearCascade(quality) { return { dist: NEAR_SHADOW_DISTANCE, size: Math.max(NEAR_SHADOW_MIN_SIZE, quality | 0) }; }

  _applyShadows() {
    const s = this.settings, r = this.game.renderer.renderer, dir = this.lights[1], near = this.nearLight;
    const shadows = !!s.get('shShadows');
    const size = s.get('shShadowQuality') | 0, dist = s.get('shShadowDistance');
    const wantNear = shadows && !!s.get('shNearShadow');
    if (shadows) this.uniforms.uShadowSlope.value = this._setupCascade(dir, dist, size);
    else if (dir.shadow.map) { dir.shadow.map.dispose(); dir.shadow.map = null; }
    if (wantNear) { const n = ShaderPipeline.nearCascade(size); this.uniforms.uNearSlope.value = this._setupCascade(near, n.dist, n.size); }
    else if (near && near.shadow.map) { near.shadow.map.dispose(); near.shadow.map = null; }
    dir.castShadow = shadows;
    if (near) near.castShadow = wantNear;
    this.uniforms.uNearShadow.value = wantNear ? 1 : 0;
    r.shadowMap.enabled = shadows;
    dir.shadow.needsUpdate = true;
    if (near) near.shadow.needsUpdate = true;
  }

  /**
   * Whether anything that casts a moving shadow sits inside the near / far boxes this frame: visible mobs (they animate
   * even when standing), dropped items (they spin and bob), other players and the own third-person body.
   */
  _motion(p, farDist) {
    const g = this.game, near = NEAR_SHADOW_DISTANCE + 2, far = farDist + 2;
    let anyNear = false, anyFar = false;
    const at = (x, z) => { const d = Math.max(Math.abs(x - p.x), Math.abs(z - p.z)); if (d <= far) anyFar = true; if (d <= near) anyNear = true; };
    if (g.playerModel && g.playerModel.root.visible) at(p.x, p.z);
    const mobs = g.entities && g.entities.mobs ? g.entities.mobs.mobs : null;
    if (mobs) for (const m of mobs) if (!m.frozen && m.root.visible) at(m.position.x, m.position.z);
    if (g.entities) for (const it of g.entities.items) if (it.group.visible) at(it.position.x, it.position.z);
    if (g.remotePlayers) for (const rp of g.remotePlayers.players.values()) if (rp.visible) at(rp.position.x, rp.position.z);
    return { near: anyNear, far: anyFar };
  }

  /**
   * Place a cascade's light so its box follows the player, snapped to texel-sized steps in light space (no shimmer).
   * Returns true when the box moved (a texel step): the map then has to re-render.
   */
  _snapLight(light, dist, size, p, sunDir) {
    const texel = (2 * dist) / size;
    this._right.set(0, 1, 0).cross(sunDir).normalize();
    this._up.copy(sunDir).cross(this._right).normalize();
    const rx = Math.round(p.dot(this._right) / texel) * texel;
    const ry = Math.round(p.dot(this._up) / texel) * texel;
    const rz = p.dot(sunDir);
    const snap = light.userData.snap || (light.userData.snap = { rx: NaN, ry: NaN, dist: 0, size: 0 });
    const moved = snap.rx !== rx || snap.ry !== ry || snap.dist !== dist || snap.size !== size;
    snap.rx = rx; snap.ry = ry; snap.dist = dist; snap.size = size;
    const target = light.target.position;
    target.copy(this._right).multiplyScalar(rx).addScaledVector(this._up, ry).addScaledVector(sunDir, rz);
    light.position.copy(target).addScaledVector(sunDir, SUN_DISTANCE);
    light.target.updateMatrixWorld();
    return moved;
  }

  _applyPost() {
    const s = this.settings, g = this.game;
    const flags = { bloom: !!s.get('shBloom'), godRays: !!s.get('shGodRays'), toneMap: !!s.get('shToneMap'), vignette: !!s.get('shVignette'), underwater: !!s.get('shUnderwater') };
    const any = flags.bloom || flags.godRays || flags.toneMap || flags.vignette || flags.underwater;
    g.renderer.setPostFlags(any ? flags : null); // the renderer owns the chain (FXAA may keep it alive without effects)
    this.post = any ? g.renderer.post : null;
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
    // Both shadow cameras follow the player, snapped to texel-sized steps in light space so shadows do not shimmer.
    const p = g.player.renderPosition;
    const size = this.settings.get('shShadowQuality') | 0, farDist = this.settings.get('shShadowDistance');
    const farMoved = this._snapLight(dir, farDist, size, p, sunDir);
    let nearMoved = false;
    if (this.nearLight && this.nearLight.castShadow) { const n = ShaderPipeline.nearCascade(size); nearMoved = this._snapLight(this.nearLight, n.dist, n.size, p, sunDir); }
    // Re-render a cascade only when needed: its box snapped, chunk geometry changed inside its box, or something moves
    // inside it (the near map every such frame, the far map at most every 4th frame); waving plants count as movement.
    this._frame++;
    const cb = g.meshManager.changeBounds;
    const touches = (half) => cb.any && cb.maxX >= p.x - half && cb.minX <= p.x + half && cb.maxZ >= p.z - half && cb.minZ <= p.z + half && cb.maxY >= p.y - half && cb.minY <= p.y + half;
    const farGeom = touches(farDist + 2), nearGeom = touches(ShaderPipeline.nearCascade(size).dist + 2);
    if (this._lastGeometryVersion !== g.meshManager.geometryVersion) { this._lastGeometryVersion = g.meshManager.geometryVersion; g.meshManager.clearChangeBounds(); }
    const waving = u.uWaving.value > 0.5;
    const motion = dir.castShadow ? this._motion(p, farDist) : { near: false, far: false };
    if (dir.castShadow && (farMoved || farGeom || ((motion.far || waving) && (this._frame & 3) === 0))) dir.shadow.needsUpdate = true;
    if (this.nearLight && this.nearLight.castShadow && (nearMoved || nearGeom || motion.near || waving)) this.nearLight.shadow.needsUpdate = true;
    // The first-person hand gets the sun from the same direction (its scene has its own lights, in view space).
    if (g.hand && g.hand.lights) { this._q.copy(cam.quaternion).invert(); g.hand.lights[1].position.copy(sunDir).applyQuaternion(this._q); }
    // New mobs, players and dropped items cast shadows too: look for new meshes about once a second.
    this.shadowScan -= dt;
    if (this.shadowScan <= 0 && dir.castShadow) {
      this.shadowScan = 1;
      const casters = this._markShadowCasters(true);
      if (casters !== this._casters) { this._casters = casters; dir.shadow.needsUpdate = true; if (this.nearLight) this.nearLight.shadow.needsUpdate = true; } // a new caster appeared
    }
    if (this.post) this.post.update(this.time, cam, sunDir, g.player.headInWater && this.settings.get('shUnderwater'), g.sky);
  }

  /** castShadow on every character / mob / item mesh (not chunks, sky, particles or overlays). Returns how many there are. */
  _markShadowCasters(on) {
    const atlas = this.game.atlas.texture;
    let count = 0;
    this.game.renderer.scene.traverse((o) => {
      if (!o.isMesh || o.name === 'section' || o.userData.noShadow) return;
      const m = o.material;
      if (!m || !(m.isMeshLambertMaterial || (m.isMeshBasicMaterial && m.map === atlas))) return;
      o.castShadow = on;
      count++;
    });
    return count;
  }

  _createLitMaterials(atlas) {
    // The chunk vertices carry tile-local coordinates and a tile index: `map` stays set so Three generates the
    // uv varying, but the texel comes from the tile array.
    const make = (key, params, shadowSide = THREE.FrontSide) => {
      const m = new THREE.MeshLambertMaterial({ map: atlas.texture, vertexColors: true, fog: true, ...params });
      m.defines = chunkPassDefines(key); // the packed vertex layout of the pass (float heights for liquids, flat lava)
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.uniforms.uTiles = { value: atlas.arrayTexture };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', VERTEX_HEAD + '\nvarying float vTile;')
          .replace('#include <uv_vertex>', VERTEX_UV)
          .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = craftonFaceNormal(cv.face);\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(tangent.xyz);\n#endif')
          .replace('#include <begin_vertex>', VERTEX_BEGIN)
          .replace('#include <color_vertex>', VERTEX_COLOR)
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', FRAGMENT_HEAD + '\nprecision highp sampler2DArray;\nuniform sampler2DArray uTiles;\nvarying float vTile;')
          .replace('#include <shadowmap_pars_fragment>', SHADOW_GLSL)
          .replace('#include <map_fragment>', 'vec4 sampledDiffuseColor = texture(uTiles, vec3(fract(vMapUv), vTile));\ndiffuseColor *= sampledDiffuseColor;')
          .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', LIGHT_MODEL)
          .replace('#include <dithering_fragment>', FRAGMENT_TAIL);
      };
      m.customProgramCacheKey = () => 'crafton-lit-' + key;
      // Never BackSide (and never null, which Three treats as BackSide for a FrontSide material): the chunk meshes are open
      // voxel shells, so back-face casting leaves a lit gap at every block-floor contact (see NORMAL_OFFSET_TEXELS).
      m.shadowSide = shadowSide;
      m.name = 'lit-' + key;
      return m;
    };
    // The chunk depth pass: the same waving and the alpha test from the tile array, so leaves and plants cast the
    // shadow they show (Three copies shadowSide, map and alphaTest from the colour material at render time).
    const depth = (key) => {
      const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas.texture });
      d.defines = chunkPassDefines(key);
      d.onBeforeCompile = (shader) => {
        shader.uniforms.uTiles = { value: atlas.arrayTexture };
        shader.uniforms.uTime = this.uniforms.uTime;
        shader.uniforms.uWaving = this.uniforms.uWaving;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', DEPTH_VERTEX_HEAD)
          .replace('#include <uv_vertex>', VERTEX_UV)
          .replace('#include <begin_vertex>', DEPTH_VERTEX_BEGIN);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nprecision highp sampler2DArray;\nuniform sampler2DArray uTiles;\nvarying float vTile;')
          .replace('#include <map_fragment>', 'vec4 sampledDiffuseColor = texture(uTiles, vec3(fract(vMapUv), vTile));\ndiffuseColor *= sampledDiffuseColor;');
      };
      d.customProgramCacheKey = () => 'crafton-depth-' + key;
      d.name = 'depth-' + key;
      return d;
    };
    // Lava: unlit and a little brighter than its texture (the bloom pass picks the glow up); never shadowed.
    const lava = createChunkMaterial(atlas.arrayTexture, 'lit-lava', { lit: false, side: THREE.DoubleSide, boost: 1.25, pass: 'lava' });
    return {
      opaque: make('opaque', { side: THREE.FrontSide }),
      cutout: make('cutout', { alphaTest: 0.5, transparent: false, side: THREE.FrontSide }),
      translucent: make('translucent', { transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }, THREE.BackSide), // water casts from its underside, as before
      lava,
      depth: { opaque: depth('opaque'), cutout: depth('cutout'), translucent: depth('translucent'), lava: depth('lava') }, // lava: the decoder, no map (its lit material has none)
    };
  }
}
