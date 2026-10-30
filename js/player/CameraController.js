// CameraController.js — first/third-person camera placement with terrain collision, perspective
// cycling (P), FOV effects for sprinting/flying and view bobbing.

import * as THREE from 'three';
import { clamp, damp } from '../utils/MathUtils.js';
import { WALK_SPEED, POSE_TRANSITION_SECONDS, BOB_SIDE, BOB_VERTICAL, BOB_ROLL, BOB_DEFAULT_INTENSITY, BOB_PHASE_PER_BLOCK, BOW_ZOOM, FOV_SPRINT, FOV_SPEED_START, FOV_SPEED_FULL, FOV_SPEED_MAX, FOV_ROCKET_PUNCH, FOV_EASE_IN, FOV_EASE_OUT, FOV_MAX_DEGREES } from '../config/Constants.js';

export const Perspective = Object.freeze({ FIRST: 0, THIRD_BACK: 1, THIRD_FRONT: 2 });
const THIRD_PERSON_DISTANCE = 4;
const CAMERA_MARGIN = 0.2;

export class CameraController {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('./Player.js').Player} player
   * @param {import('./BlockRaycaster.js').BlockRaycaster} raycaster
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(camera, player, raycaster, settings) {
    this.hurtTilt = 0; this.hurtSide = 1;
    /** Explosion shake: amplitude in blocks, decaying. */
    this.shakeAmp = 0;
    /** A rocket boost: a quick extra FOV punch that decays over about half a second. */
    this.rocketPunch = 0;
    /** The FOV widening target of the last frame (before the bow zoom), for the debug line and the tests. */
    this.fovTarget = 1;
    this.camera = camera;
    this.player = player;
    this.raycaster = raycaster;
    this.settings = settings;
    this.perspective = Perspective.FIRST;
    this.fovScale = 1;
    this.bobFactor = 0;
    this.bobPhase = 0;
    /** Intensity multiplier from the setting (1 at the 50 % default). */
    this.bobIntensity = 1;
    /** bobFactor × intensity, for the first-person hand. */
    this.handBobFactor = 0;
    this.eye = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  get isFirstPerson() { return this.perspective === Perspective.FIRST; }

  cycle() {
    this.perspective = (this.perspective + 1) % 3;
  }

  /** Update camera transform and FOV; returns the bob phase for the hand. */
  /** A hit landed: tilt the camera (the side follows the knockback direction when known). */
  hurt(kx = 0, kz = 0) {
    this.hurtTilt = 1;
    const right = Math.cos(this.player.yaw) * kx - Math.sin(this.player.yaw) * kz;
    this.hurtSide = right < 0 ? -1 : 1;
  }

  /** A nearby explosion: a short camera shake of `strength` (0..1). */
  shake(strength) { this.shakeAmp = Math.max(this.shakeAmp, Math.min(1, strength) * 0.25); }

  /** A rocket fired: punch the FOV in for a moment. */
  rocket() { this.rocketPunch = 1; }

  update(dt) {
    const p = this.player;
    const cam = this.camera;
    // Pose changes (sneak / swim / crawl) ease the camera height over ~0.25 s.
    p.renderEyeHeight = damp(p.renderEyeHeight, p.eyeHeight, 4 / POSE_TRANSITION_SECONDS, dt);
    p.getEyePosition(this.eye);
    p.getLookDirection(this.dir);

    // View bobbing: capped at walking strength (running only speeds the phase up), scaled by the slider.
    const setting = this.settings.get('viewBobbing');
    this.bobIntensity = (typeof setting === 'number' ? setting : setting ? BOB_DEFAULT_INTENSITY : 0) / BOB_DEFAULT_INTENSITY;
    const bobbing = this.bobIntensity > 0 && p.onGround && !p.flying && !p.inWater && !p.inLava && !p.swimming;
    const targetBob = bobbing ? clamp(p.horizontalSpeed / WALK_SPEED, 0, 1.0) : 0;
    this.bobFactor = damp(this.bobFactor, targetBob, 10, dt);
    this.handBobFactor = this.bobFactor * this.bobIntensity;
    this.bobPhase = p.walkDistance * BOB_PHASE_PER_BLOCK; // slower cycle: each step reads as a step
    // Hurt tilt: a quick roll away from the hit that eases back.
    this.hurtTilt = damp(this.hurtTilt, 0, 7, dt);
    const hurtRoll = Math.sin(Math.min(1, this.hurtTilt) * Math.PI) * 0.14 * this.hurtSide;

    // FOV effects, all scaled by the "FOV Effects" option: +20 % sprinting; a speed widening while falling fast, flying
    // fast or gliding (from FOV_SPEED_START up to +50 % at FOV_SPEED_FULL); a rocket's quick punch-in; the bow zoom-in.
    // Every contribution feeds ONE target, which is smoothed with exponential easing (time constants FOV_EASE_IN toward a
    // wider view — including the zoom easing back when the bow is released — and FOV_EASE_OUT toward a narrower one, in
    // game time, frame-rate independent); nothing sets the camera FOV directly. The shown FOV is clamped to FOV_MAX_DEGREES.
    const effects = clamp((this.settings.get('fovEffects') ?? 100) / 100, 0, 1);
    let widen = 0;
    if (p.sprinting) widen += FOV_SPRINT;
    const falling = !p.onGround && !p.inWater && !p.inLava && p.velocity.y < 0;
    if (p.gliding || p.flying || falling) {
      const speed = p.velocity.length();
      widen += clamp((speed - FOV_SPEED_START) / (FOV_SPEED_FULL - FOV_SPEED_START), 0, 1) * FOV_SPEED_MAX;
    }
    this.rocketPunch = damp(this.rocketPunch, 0, 4, dt);
    widen += this.rocketPunch * FOV_ROCKET_PUNCH;
    const zoom = p.drawProgress > 0 ? 1 - BOW_ZOOM * Math.min(1, p.drawProgress) : 1;
    const targetScale = (1 + widen * effects) * zoom;
    this.fovTarget = targetScale;
    const tau = targetScale > this.fovScale ? FOV_EASE_IN : FOV_EASE_OUT;
    this.fovScale += (targetScale - this.fovScale) * (1 - Math.exp(-dt / tau));
    this.shakeAmp = damp(this.shakeAmp, 0, 6, dt);
    const fov = Math.min(FOV_MAX_DEGREES, this.settings.get('fov') * this.fovScale);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }

    if (this.perspective === Perspective.FIRST) {
      cam.position.copy(this.eye);
      const f = this.bobFactor * this.bobIntensity;
      if (f > 0.001) {
        this._right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
        cam.position.addScaledVector(this._right, Math.sin(this.bobPhase) * BOB_SIDE * f);
        cam.position.y += Math.abs(Math.cos(this.bobPhase)) * BOB_VERTICAL * f;
      }
      if (this.shakeAmp > 0.001) { cam.position.x += (Math.random() - 0.5) * this.shakeAmp; cam.position.y += (Math.random() - 0.5) * this.shakeAmp; cam.position.z += (Math.random() - 0.5) * this.shakeAmp; }
      this._euler.set(p.pitch, p.yaw, (f > 0.001 ? Math.sin(this.bobPhase) * BOB_ROLL * f : 0) + hurtRoll + (this.shakeAmp > 0.001 ? (Math.random() - 0.5) * this.shakeAmp * 0.5 : 0));
      cam.quaternion.setFromEuler(this._euler);
    } else if (this.perspective === Perspective.THIRD_BACK) {
      const d = this._collide(-this.dir.x, -this.dir.y, -this.dir.z);
      cam.position.copy(this.eye).addScaledVector(this.dir, -d);
      this._euler.set(p.pitch, p.yaw, 0);
      cam.quaternion.setFromEuler(this._euler);
    } else {
      const d = this._collide(this.dir.x, this.dir.y, this.dir.z);
      cam.position.copy(this.eye).addScaledVector(this.dir, d);
      this._euler.set(-p.pitch, p.yaw + Math.PI, 0);
      cam.quaternion.setFromEuler(this._euler);
    }
  }

  _collide(dx, dy, dz) {
    const d = this.raycaster.solidDistance(this.eye.x, this.eye.y, this.eye.z, dx, dy, dz, THIRD_PERSON_DISTANCE + CAMERA_MARGIN);
    return clamp(d - CAMERA_MARGIN, 0.3, THIRD_PERSON_DISTANCE);
  }
}
