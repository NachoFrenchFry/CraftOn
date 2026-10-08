// Player.js — player state: position, velocity, look angles, movement flags and game mode.

import * as THREE from 'three';
import { PLAYER_WIDTH, PLAYER_HEIGHT, PLAYER_SNEAK_HEIGHT, PLAYER_EYE_HEIGHT, PLAYER_SNEAK_EYE_HEIGHT, PLAYER_SWIM_HEIGHT, PLAYER_SWIM_EYE_HEIGHT } from '../config/Constants.js';
import { AABB } from '../utils/AABB.js';

export const GameMode = Object.freeze({ SURVIVAL: 'survival', CREATIVE: 'creative', SPECTATOR: 'spectator' });
export const GAME_MODE_ORDER = Object.freeze([GameMode.SURVIVAL, GameMode.CREATIVE, GameMode.SPECTATOR]);

export class Player {
  constructor() {
    this.position = new THREE.Vector3(0, 80, 0);    // feet position (physics state)
    this.prevPosition = new THREE.Vector3(0, 80, 0); // previous physics state for interpolation
    this.renderPosition = new THREE.Vector3(0, 80, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;    // radians; 0 looks toward -Z
    this.pitch = 0;  // radians; positive looks up
    this.onGround = false;
    this.sneaking = false;
    this.sprinting = false;
    this.flying = false;
    this.inWater = false;
    this.headInWater = false;
    /** Sprint-swimming (small hitbox, 3D movement). */
    this.swimming = false;
    /** Low pose kept after swimming because there is no headroom to stand. */
    this.crawling = false;
    /** Set by physics when the last step was blocked horizontally, with the blocked directions. */
    this.blockedHorizontally = false;
    this.blockedDirX = 0;
    this.blockedDirZ = 0;
    /** Seconds left in which the water ledge climb may continue after leaving the water. */
    this.climbTimer = 0;
    /** Accumulated swim animation time. */
    this.swimTime = 0;
    /** Smoothed eye height used for rendering (pose changes ease over POSE_TRANSITION_SECONDS). */
    this.renderEyeHeight = PLAYER_EYE_HEIGHT;
    this.gameMode = GameMode.SURVIVAL;
    /** Spectator fly-speed multiplier (mouse wheel). */
    this.spectatorSpeed = 1;
    this.spawn = new THREE.Vector3(0, 80, 0);
    this.aabb = new AABB();
    /** Distance walked, for footsteps. */
    this.walkDistance = 0;
    this.horizontalSpeed = 0;
    this.fallStartY = null;
    this.lastLandingFall = 0;
    /** Health (Update #9 §8): 100 max, saved with the player; `dead` while the death screen shows. */
    this.maxHealth = 100;
    this.health = 100;
    this.dead = false;
    /** Movement intent set by PlayerController each fixed step. */
    this.intent = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, up: false, down: false, holdPose: false };
  }

  get isCreative() { return this.gameMode === GameMode.CREATIVE; }
  get isSpectator() { return this.gameMode === GameMode.SPECTATOR; }
  /** Creative and Spectator may fly; only Survival cannot. */
  get canFly() { return this.gameMode !== GameMode.SURVIVAL; }
  /** True while in the low swimming / crawling pose. */
  get lowPose() { return this.swimming || this.crawling; }
  get height() { return this.lowPose ? PLAYER_SWIM_HEIGHT : this.sneaking ? PLAYER_SNEAK_HEIGHT : PLAYER_HEIGHT; }
  /** Target eye height for the current pose (renderEyeHeight eases toward it). */
  get eyeHeight() { return this.lowPose ? PLAYER_SWIM_EYE_HEIGHT : this.sneaking ? PLAYER_SNEAK_EYE_HEIGHT : PLAYER_EYE_HEIGHT; }

  /** Update the AABB from the current physics position. */
  updateAABB() {
    this.aabb.setFromFeet(this.position.x, this.position.y, this.position.z, PLAYER_WIDTH, this.height);
    return this.aabb;
  }

  /** Interpolated eye position for rendering (uses the smoothed eye height). */
  getEyePosition(out) {
    return out.set(this.renderPosition.x, this.renderPosition.y + this.renderEyeHeight, this.renderPosition.z);
  }

  /** Unit look direction from yaw/pitch. */
  getLookDirection(out) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.prevPosition.set(x, y, z);
    this.renderPosition.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.fallStartY = null;
    this.blockedHorizontally = false;
    this.climbTimer = 0;
  }

  interpolate(alpha) {
    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
  }

  serialize() {
    return {
      x: this.position.x, y: this.position.y, z: this.position.z,
      yaw: this.yaw, pitch: this.pitch, flying: this.flying, gameMode: this.gameMode,
      spawnX: this.spawn.x, spawnY: this.spawn.y, spawnZ: this.spawn.z,
      health: this.health,
    };
  }

  deserialize(d) {
    if (!d) return;
    this.teleport(d.x, d.y, d.z);
    this.yaw = d.yaw || 0;
    this.pitch = d.pitch || 0;
    this.flying = !!d.flying;
    if (d.gameMode) this.gameMode = d.gameMode;
    if (d.spawnX !== undefined) this.spawn.set(d.spawnX, d.spawnY, d.spawnZ);
    this.dead = false;
    // Saved while dead (Leave World on the death screen) or before health existed: respawn with full health.
    if (typeof d.health === 'number' && d.health > 0) this.health = Math.min(this.maxHealth, d.health);
    else { this.health = this.maxHealth; if (typeof d.health === 'number') this.teleport(this.spawn.x, this.spawn.y, this.spawn.z); }
  }
}
