// PlayerPhysics.js — fixed-step player movement: acceleration/friction, gravity, water (jumping out,
// ledge climbing, sprint-swimming with a small hitbox), flying, swept AABB collision against the
// voxel grid (Y, then X, then Z), sneaking edge protection and the crawl pose.

import * as C from '../config/Constants.js';
import { isWater, heightOf } from '../world/WaterLevels.js';
import { isSolidAt, sweepAxis, hasSupport, hasHeadroom } from '../entities/EntityPhysics.js';
import { stepHorizontal, stepFlyVertical } from './Movement.js';

const EPS = C.COLLISION_EPSILON;

export class PlayerPhysics {
  /**
   * @param {import('./Player.js').Player} player
   * @param {import('../world/World.js').World} world
   * @param {import('../core/EventBus.js').EventBus} events
   */
  constructor(player, world, events) {
    this.player = player;
    this.world = world;
    this.events = events;
    /** Set by Game: flowing water pushes the player. */
    this.waterSim = null;
    this._flow = { x: 0, y: 0, z: 0 };
  }

  _isSolid(x, y, z) { return isSolidAt(this.world, x, y, z); }

  /** One-axis swept collision (shared with mobs, see entities/EntityPhysics.js). */
  _sweep(box, axis, delta) { return sweepAxis(this.world, box, axis, delta); }

  /** Is there solid ground anywhere under the box's footprint? */
  _hasSupport(box) { return hasSupport(this.world, box); }

  _isWater(x, y, z) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const id = this.world.getBlock(bx, by, bz);
    if (!isWater(id)) return false;
    if (isWater(this.world.getBlock(bx, by + 1, bz))) return true;
    return y - by < heightOf(id);
  }

  /** Is the space above the current box free up to `height` above the feet? */
  _hasHeadroom(p, height) { return hasHeadroom(this.world, p.aabb, height); }

  /**
   * Standable surface height of the column the player is pressing against (blockedDirX/Z), where
   * the surface has two free blocks above it, or -1 when there is none within reach.
   */
  _ledgeTop(p) {
    const box = p.aabb;
    const feetY = Math.floor(box.minY);
    let best = -1;
    const columns = [];
    if (p.blockedDirX !== 0) columns.push([p.blockedDirX > 0 ? Math.floor(box.maxX + 0.05) : Math.floor(box.minX - 0.05), Math.floor((box.minZ + box.maxZ) / 2)]);
    if (p.blockedDirZ !== 0) columns.push([Math.floor((box.minX + box.maxX) / 2), p.blockedDirZ > 0 ? Math.floor(box.maxZ + 0.05) : Math.floor(box.minZ - 0.05)]);
    for (const [bx, bz] of columns) {
      for (let y = feetY; y <= feetY + 2; y++) {
        if (this._isSolid(bx, y, bz) && !this._isSolid(bx, y + 1, bz) && !this._isSolid(bx, y + 2, bz)) {
          if (best < 0 || y + 1 < best) best = y + 1;
          break;
        }
      }
    }
    return best;
  }

  /** Swimming starts/stops and the crawl pose (Task 6), then sneaking. */
  _updatePose(p, intent, midWater) {
    const wasSwimming = p.swimming;
    if (p.flying) { p.swimming = false; p.crawling = false; }
    else if (p.swimming) {
      const released = !intent.sprint || intent.forward <= 0;
      if (!p.inWater || (released && !intent.holdPose)) p.swimming = false;
    } else if (p.inWater && intent.sprint && intent.forward > 0 && (p.headInWater || midWater)) {
      p.swimming = true;
      p.swimTime = 0;
    }
    if (p.swimming) p.crawling = false;
    else if (wasSwimming || p.crawling) {
      p.updateAABB();
      p.crawling = !this._hasHeadroom(p, C.PLAYER_HEIGHT);
    }
    const wantSneak = intent.sneak && !p.flying && !p.lowPose;
    if (wantSneak !== p.sneaking) {
      p.sneaking = wantSneak;
      p.updateAABB();
      if (!p.sneaking && !this._hasHeadroom(p, C.PLAYER_HEIGHT)) p.sneaking = true;
    }
    p.updateAABB();
  }

  /** Noclip flight for spectators (speed scaled by the wheel-adjusted multiplier). */
  _stepSpectator(p, v, intent, dt) {
    p.flying = true; p.swimming = false; p.crawling = false; p.sneaking = false; p.onGround = false;
    p.inWater = false; p.headInWater = false; p.fallStartY = null;
    const sinY = Math.sin(p.yaw), cosY = Math.cos(p.yaw);
    let fx = -sinY * intent.forward + cosY * intent.strafe;
    let fz = -cosY * intent.forward - sinY * intent.strafe;
    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }
    const speed = (intent.sprint ? C.SPRINT_FLY_SPEED : C.FLY_SPEED) * p.spectatorSpeed;
    p.sprinting = intent.sprint && len > 0;
    stepHorizontal(v, fx, fz, speed, 'fly', dt);
    v.y = stepFlyVertical(v.y, (intent.up ? 1 : 0) - (intent.down ? 1 : 0), speed * 0.8, dt);
    p.position.x += v.x * dt; p.position.y += v.y * dt; p.position.z += v.z * dt;
    p.updateAABB();
    p.horizontalSpeed = Math.hypot(v.x, v.z);
    p.blockedHorizontally = false;
  }

  step(dt) {
    const p = this.player;
    const v = p.velocity;
    const intent = p.intent;
    p.prevPosition.copy(p.position);

    // Spectator: fly through everything; no gravity, water or collision.
    if (p.isSpectator) { this._stepSpectator(p, v, intent, dt); return; }

    // Unloaded chunk under the player: freeze so they never fall through the world.
    if (!this.world.isLoadedAt(p.position.x, p.position.z)) {
      v.set(0, 0, 0);
      return;
    }

    // Water state (sampled with the current pose).
    const feetWater = this._isWater(p.position.x, p.position.y + 0.2, p.position.z);
    const midWater = this._isWater(p.position.x, p.position.y + p.height * 0.5, p.position.z);
    const wasInWater = p.inWater;
    p.inWater = feetWater || midWater;
    p.headInWater = this._isWater(p.position.x, p.position.y + p.eyeHeight, p.position.z);
    if (p.inWater && !wasInWater && v.y < -6) this.events.emit('player:splash', -v.y);
    if (p.inWater) p.flying = p.flying && p.isCreative;

    this._updatePose(p, intent, midWater);

    // Flowing water pushes the player gently along its flow.
    if (p.inWater && this.waterSim && !p.flying) {
      const fy = feetWater ? Math.floor(p.position.y + 0.2) : Math.floor(p.position.y + p.height * 0.5);
      const f = this.waterSim.flowVector(Math.floor(p.position.x), fy, Math.floor(p.position.z), this._flow);
      v.x += f.x * C.WATER_PUSH_ACCEL * dt;
      v.z += f.z * C.WATER_PUSH_ACCEL * dt;
      v.y += f.y * C.WATER_PUSH_ACCEL * 0.5 * dt;
    }

    // Horizontal intent in world space.
    const sinY = Math.sin(p.yaw), cosY = Math.cos(p.yaw);
    let fx = -sinY * intent.forward + cosY * intent.strafe;
    let fz = -cosY * intent.forward - sinY * intent.strafe;
    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }
    const moving = len > 0;

    p.sprinting = intent.sprint && moving && !p.sneaking && !p.crawling;
    let speed;
    if (p.flying) speed = p.sprinting ? C.SPRINT_FLY_SPEED : C.FLY_SPEED;
    else if (p.swimming) speed = C.SWIM_SPRINT_SPEED;
    else if (p.inWater) speed = C.SWIM_SPEED * (p.sprinting ? 1.3 : 1);
    else if (p.sneaking || p.crawling) speed = C.SNEAK_SPEED;
    else speed = p.sprinting ? C.SPRINT_SPEED : C.WALK_SPEED;

    if (p.swimming) {
      // 3D movement along the look direction (pitch included); strafe stays horizontal.
      const cp = Math.cos(p.pitch);
      const tx = -sinY * cp * intent.forward * speed + cosY * intent.strafe * C.SWIM_SPEED;
      const ty = Math.sin(p.pitch) * intent.forward * speed;
      const tz = -cosY * cp * intent.forward * speed - sinY * intent.strafe * C.SWIM_SPEED;
      const blend = 1 - Math.exp(-8 * dt);
      v.x += (tx - v.x) * blend;
      v.z += (tz - v.z) * blend;
      v.y += (ty - v.y) * blend;
      v.y -= C.SWIM_GRAVITY * dt;
      if (intent.jump) v.y = Math.max(v.y, Math.min(v.y + 24 * dt, C.SWIM_UP_SPEED));
      p.swimTime += dt * Math.max(0.5, Math.hypot(v.x, v.y, v.z) / C.SWIM_SPRINT_SPEED);
      p.fallStartY = null;
    } else {
      // Velocity + drag movement (Movement.js): accelerate while pushing, drag every tick; the air keeps
      // momentum with a fifth of the control. Water keeps its gentle blend toward the target.
      if (p.inWater && !p.flying) {
        const blend = 1 - Math.exp(-12 * dt);
        v.x += (fx * speed - v.x) * blend;
        v.z += (fz * speed - v.z) * blend;
      } else {
        stepHorizontal(v, fx, fz, speed, p.flying ? 'fly' : p.onGround ? 'ground' : 'air', dt);
      }

      // Vertical motion.
      if (p.flying) {
        v.y = stepFlyVertical(v.y, (intent.up ? 1 : 0) - (intent.down ? 1 : 0), speed * 0.8, dt);
        p.fallStartY = null;
      } else if (p.inWater) {
        if (intent.jump && p.onGround) {
          // Shallow water: a normal (slightly reduced) jump gets you out.
          v.y = C.JUMP_VELOCITY * C.WATER_JUMP_FACTOR;
          p.onGround = false;
          this.events.emit('player:jump');
        } else {
          v.y -= C.WATER_GRAVITY * dt;
          if (intent.jump) v.y = Math.min(v.y + 24 * dt, C.SWIM_UP_SPEED);
          v.y *= Math.exp(-2.5 * dt);
          if (v.y < -C.WATER_TERMINAL_VELOCITY) v.y = -C.WATER_TERMINAL_VELOCITY;
        }
        p.fallStartY = null;
      } else {
        if (intent.jump && p.onGround) {
          v.y = C.JUMP_VELOCITY;
          if (p.sprinting) { v.x += fx * C.SPRINT_JUMP_BOOST; v.z += fz * C.SPRINT_JUMP_BOOST; }
          p.onGround = false;
          this.events.emit('player:jump');
        }
        v.y -= C.GRAVITY * dt;
        if (v.y < -C.TERMINAL_VELOCITY) v.y = -C.TERMINAL_VELOCITY;
        if (!p.onGround && p.fallStartY === null && v.y < 0) p.fallStartY = p.position.y;
      }
    }

    // Climbing out of water: while pressing against a ledge with jump held, keep rising until the
    // box clears the ledge. Only for ledges the player can stand on within reach.
    if (!p.flying && intent.jump && p.blockedHorizontally && (p.inWater || p.climbTimer > 0)) {
      const ledgeTop = this._ledgeTop(p);
      if (ledgeTop >= 0 && ledgeTop - p.position.y <= C.WATER_CLIMB_MAX_RISE && ledgeTop > p.position.y + 0.01) {
        v.y = Math.max(v.y, C.WATER_LEDGE_BOOST);
        if (p.inWater) p.climbTimer = C.WATER_CLIMB_GRACE;
      }
    }
    if (p.climbTimer > 0) p.climbTimer -= dt;

    // Move with collision: Y, then X, then Z.
    const box = p.updateAABB();
    let dx = v.x * dt, dy = v.y * dt, dz = v.z * dt;
    const movedY = this._sweep(box, 1, dy);
    const wasOnGround = p.onGround;
    if (movedY !== dy) {
      if (dy < 0) {
        p.onGround = true;
        if (!wasOnGround) {
          const fall = p.fallStartY !== null ? p.fallStartY - p.position.y : 0;
          p.lastLandingFall = fall;
          this.events.emit('player:land', fall);
        }
        p.fallStartY = null;
      }
      v.y = 0;
    } else if (dy !== 0) {
      p.onGround = false;
    }
    box.translate(0, movedY, 0);

    // Sneaking edge protection.
    const protect = p.sneaking && p.onGround && !p.flying;
    let movedX = this._sweep(box, 0, dx);
    if (protect && movedX !== 0) {
      box.translate(movedX, 0, 0);
      if (!this._hasSupport(box)) { box.translate(-movedX, 0, 0); movedX = 0; v.x = 0; }
    } else {
      box.translate(movedX, 0, 0);
    }
    const blockedX = movedX !== dx;
    if (blockedX) v.x = 0;

    let movedZ = this._sweep(box, 2, dz);
    if (protect && movedZ !== 0) {
      box.translate(0, 0, movedZ);
      if (!this._hasSupport(box)) { box.translate(0, 0, -movedZ); movedZ = 0; v.z = 0; }
    } else {
      box.translate(0, 0, movedZ);
    }
    const blockedZ = movedZ !== dz;
    if (blockedZ) v.z = 0;
    p.blockedHorizontally = (blockedX && dx !== 0) || (blockedZ && dz !== 0);
    p.blockedDirX = blockedX ? Math.sign(dx) : 0;
    p.blockedDirZ = blockedZ ? Math.sign(dz) : 0;

    // Ground check when standing still (blocks removed underfoot).
    if (p.onGround && dy >= 0 && !this._hasSupport(box)) p.onGround = false;
    if (p.flying) p.onGround = false;

    p.position.set((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2);
    p.horizontalSpeed = Math.hypot(movedX, movedZ) / dt;
    if (p.onGround && !p.inWater) p.walkDistance += Math.hypot(movedX, movedZ);

    if (p.position.y < C.VOID_Y) this.events.emit('player:void'); // Survival dies (Update #9 §8); other modes are put back at the spawn
  }
}
