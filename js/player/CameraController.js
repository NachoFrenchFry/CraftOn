// CameraController.js — first/third-person camera placement with terrain collision, perspective
// cycling (P), FOV effects for sprinting/flying and view bobbing.

import * as THREE from 'three';
import { clamp, damp } from '../utils/MathUtils.js';
import { WALK_SPEED, POSE_TRANSITION_SECONDS, BOB_SIDE, BOB_VERTICAL, BOB_ROLL, BOB_DEFAULT_INTENSITY, BOB_PHASE_PER_BLOCK } from '../config/Constants.js';

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
    const bobbing = this.bobIntensity > 0 && p.onGround && !p.flying && !p.inWater && !p.swimming;
    const targetBob = bobbing ? clamp(p.horizontalSpeed / WALK_SPEED, 0, 1.0) : 0;
    this.bobFactor = damp(this.bobFactor, targetBob, 10, dt);
    this.handBobFactor = this.bobFactor * this.bobIntensity;
    this.bobPhase = p.walkDistance * BOB_PHASE_PER_BLOCK; // slower cycle (Update #8): each step reads as a step

    // FOV: +10% sprinting, a bit more when flying fast.
    let targetScale = 1;
    if (p.sprinting) targetScale = p.flying ? 1.15 : 1.1;
    this.fovScale = damp(this.fovScale, targetScale, 8, dt);
    const fov = this.settings.get('fov') * this.fovScale;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }

    if (this.perspective === Perspective.FIRST) {
      cam.position.copy(this.eye);
      const f = this.bobFactor * this.bobIntensity;
      if (f > 0.001) {
        this._right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
        cam.position.addScaledVector(this._right, Math.sin(this.bobPhase) * BOB_SIDE * f);
        cam.position.y += Math.abs(Math.cos(this.bobPhase)) * BOB_VERTICAL * f;
      }
      this._euler.set(p.pitch, p.yaw, f > 0.001 ? Math.sin(this.bobPhase) * BOB_ROLL * f : 0);
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
