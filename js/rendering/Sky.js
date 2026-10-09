// Sky.js — sky color / gradient dome, sun, and linear fog sized to the render distance.
// Switches to dense blue fog while the camera is underwater.

import * as THREE from 'three';
import { SKY_COLOR, WATER_FOG_COLOR, CHUNK_SIZE, UNDERWATER_FOG_NEAR, UNDERWATER_FOG_FAR, UNDERWATER_SKY_TINT, LAVA_FOG_COLOR, LAVA_FOG_NEAR, LAVA_FOG_FAR } from '../config/Constants.js';

const SKY_VERT = `
varying vec3 vWorldDir;
void main() {
  vWorldDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // push to the far plane
}`;
const SKY_FRAG = `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 bottomColor;
varying vec3 vWorldDir;
void main() {
  float h = vWorldDir.y;
  vec3 c = h >= 0.0 ? mix(horizonColor, topColor, pow(h, 0.6)) : mix(horizonColor, bottomColor, pow(-h, 0.5));
  gl_FragColor = vec4(c, 1.0);
}`;

export class Sky {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.skyColor = new THREE.Color(SKY_COLOR);
    this.waterColor = new THREE.Color(WATER_FOG_COLOR);
    this.lavaColor = new THREE.Color(LAVA_FOG_COLOR);
    this.underwater = false;
    /** null | 'water' | 'lava': the liquid the camera is inside (Update #11). */
    this.liquid = null;
    this.renderDistance = 8;
    scene.background = this.skyColor.clone();
    scene.fog = new THREE.Fog(this.skyColor.clone(), 40, 120);

    // Base sky colors; underwater they are blended toward the water color (the dome ignores fog).
    this.baseColors = { top: new THREE.Color(0x4a8fe0), horizon: this.skyColor.clone(), bottom: new THREE.Color(0x6a97b8), sun: new THREE.Color(0xfff7c0) };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(500, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: {
          topColor: { value: this.baseColors.top.clone() },
          horizonColor: { value: this.baseColors.horizon.clone() },
          bottomColor: { value: this.baseColors.bottom.clone() },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
    );
    this.dome.renderOrder = -1000;
    this.dome.userData.noShadow = true;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    // The sun is opaque and depth-tested (depthWrite off) so terrain in front of it hides it; it is drawn
    // right after the dome, before the chunks.
    const sunGeom = new THREE.PlaneGeometry(40, 40);
    const sunMat = new THREE.MeshBasicMaterial({ color: this.baseColors.sun.clone(), fog: false, depthWrite: false, depthTest: true, transparent: false });
    this.sun = new THREE.Mesh(sunGeom, sunMat);
    this.sun.renderOrder = -999;
    this.sun.userData.noShadow = true;
    this.sun.frustumCulled = false;
    this.sunDir = new THREE.Vector3(0.45, 0.75, 0.3).normalize();
    scene.add(this.sun);
    // Soft glow ring behind the sun, also depth-tested.
    const glowMat = new THREE.MeshBasicMaterial({ color: this.baseColors.sun.clone(), fog: false, depthWrite: false, depthTest: true, transparent: true, opacity: 0.22 });
    this.sunGlow = new THREE.Mesh(new THREE.PlaneGeometry(72, 72), glowMat);
    this.sunGlow.renderOrder = -999;
    this.sunGlow.userData.noShadow = true;
    this.sunGlow.frustumCulled = false;
    scene.add(this.sunGlow);
    this.setRenderDistance(8);
  }

  setRenderDistance(chunks) {
    this.renderDistance = chunks;
    this._applyFog();
  }

  setUnderwater(flag) { this.setLiquid(flag ? 'water' : null); }

  /** The camera entered / left a liquid: dense blue fog in water, dense orange fog in lava (Update #11). */
  setLiquid(kind) {
    if (this.liquid === kind) return;
    this.liquid = kind;
    this.underwater = kind === 'water';
    this._applyFog();
  }

  /** Blend the dome and sun colors toward the water color by `t` (0 = normal sky). */
  _tintSky(t, color = this.waterColor) {
    const u = this.dome.material.uniforms;
    u.topColor.value.copy(this.baseColors.top).lerp(color, t);
    u.horizonColor.value.copy(this.baseColors.horizon).lerp(color, t);
    u.bottomColor.value.copy(this.baseColors.bottom).lerp(color, t);
    this.sun.material.color.copy(this.baseColors.sun).lerp(color, t);
    this.sunGlow.material.color.copy(this.baseColors.sun).lerp(color, t);
  }

  _applyFog() {
    const fog = this.scene.fog;
    if (this.liquid === 'lava') {
      // Inside lava: nothing but orange a few blocks out.
      fog.color.copy(this.lavaColor);
      fog.near = LAVA_FOG_NEAR;
      fog.far = LAVA_FOG_FAR;
      this.scene.background.copy(this.lavaColor);
      this._tintSky(1, this.lavaColor);
    } else if (this.underwater) {
      // Blue-tinted but still see-through: the sky and sun stay visible through the surface.
      fog.color.copy(this.waterColor);
      fog.near = UNDERWATER_FOG_NEAR;
      fog.far = UNDERWATER_FOG_FAR;
      this.scene.background.copy(this.waterColor);
      this._tintSky(UNDERWATER_SKY_TINT);
    } else {
      const dist = this.renderDistance * CHUNK_SIZE;
      fog.color.copy(this.skyColor);
      fog.near = dist * 0.6;
      fog.far = dist * 0.95;
      this.scene.background.copy(this.skyColor);
      this._tintSky(0);
    }
  }

  /** Keep the dome and sun centered on the camera. */
  update(camera) {
    this.dome.position.copy(camera.position);
    this.sun.position.copy(camera.position).addScaledVector(this.sunDir, 400);
    this.sun.lookAt(camera.position);
    this.sunGlow.position.copy(camera.position).addScaledVector(this.sunDir, 402);
    this.sunGlow.lookAt(camera.position);
  }
}
