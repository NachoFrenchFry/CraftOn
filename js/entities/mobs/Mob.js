// Mob.js — a mob (passive, or hostile with a ZombieAI): health, AI, voxel physics (shared with the player), model
// animation (four-legged animals and the humanoid zombie), hurt flash / knockback, death tip-over and serialization.

import * as THREE from 'three';
import { AABB } from '../../utils/AABB.js';
import { Random } from '../../utils/Random.js';
import { MobAI, MobState } from './MobAI.js';
import { ZombieAI } from './ZombieAI.js';
import { createMobModel } from './MobModel.js';
import { moveBox, hasSupport, isSolidAt } from '../EntityPhysics.js';
import { isWater, isLava } from '../../world/WaterLevels.js';
import { multiplyLight, sameLight, copyLight } from '../../rendering/LightUniforms.js';
import * as C from '../../config/Constants.js';
import { angleDelta, damp, clamp } from '../../utils/MathUtils.js';
import { SEA_LEVEL } from '../../config/Constants.js';

const HURT_RED = new THREE.Color(1, 0.35, 0.35);
const WHITE = new THREE.Color(1, 1, 1);

export class Mob {
  /**
   * @param {object} def Cow / Pig / Sheep definition
   * @param {Map<string, THREE.Texture>} textures
   */
  constructor(def, textures, x, y, z, seed = (Math.random() * 4294967296) >>> 0) {
    this.def = def;
    this.type = def.type;
    this.position = new THREE.Vector3(x, y, z);
    this.prevPosition = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.headYaw = this.yaw;
    this.health = def.health;
    this.rng = new Random(seed);
    this.ai = def.hostile ? new ZombieAI(this.rng) : new MobAI(this.rng);
    this.intent = { dirX: 0, dirZ: 0, speed: 0, headYaw: this.yaw, attack: false, targetBelow: false, targetId: null };
    /** Hostile: seconds left of the arm swing after a hit. */
    this.attackTimer = 0;
    /** The world the mob lives in (set by MobManager; the pathfinder reads blocks through it). */
    this.world = null;
    this.aiTimer = this.rng.next() * C.MOB_AI_INTERVAL;
    this.onGround = false;
    this.inWater = false;
    /** Lava: in lava, the lava damage tick, seconds left burning, the fire damage tick. */
    this.inLava = false;
    this.lavaTimer = 0;
    this.fireTimer = 0;
    this.burnTick = 0;
    /** Fall damage: where the fall began, and the last landing's distance for MobManager. */
    this.fallStartY = null;
    this.lastFall = 0;
    this.justLanded = false;
    this.stuckTimer = 0;
    this.flashTimer = 0;
    this.invulnTimer = 0;
    this.deathTimer = -1;
    this.dead = false;         // removed once the death animation ends
    this.walkTime = 0;
    this.walkDistance = 0;
    this.lastStepDistance = 0;
    const amb = def.ambientInterval || [8, 25];
    this.ambientTimer = amb[0] + this.rng.next() * (amb[1] - amb[0]);
    this.frozen = false;
    this.aabb = new AABB();
    this.model = createMobModel(def, textures);
    this.root = this.model.root;
    this._move = {};
    this._flow = { x: 0, y: 0, z: 0 };
    this.updateAABB();
  }

  get isDying() { return this.deathTimer >= 0; }

  updateAABB() {
    return this.aabb.setFromFeet(this.position.x, this.position.y, this.position.z, this.def.hitbox[0], this.def.hitbox[1]);
  }

  get isHostile() { return !!this.def.hostile; }

  /** Take damage from a position (knockback away from it, scaled by `knockbackScale`: a stick doubles it). Returns true if the mob died. */
  hurt(damage, fromX, fromZ, knockback = true, knockbackScale = 1) {
    if (this.isDying || this.invulnTimer > 0) return false;
    this.health -= damage;
    this.invulnTimer = C.MOB_INVULNERABLE_SECONDS;
    this.flashTimer = C.MOB_HURT_FLASH_SECONDS;
    if (knockback) {
      const dx = this.position.x - fromX, dz = this.position.z - fromZ;
      const len = Math.hypot(dx, dz) || 1;
      this.velocity.x += (dx / len) * C.MOB_KNOCKBACK * knockbackScale;
      this.velocity.z += (dz / len) * C.MOB_KNOCKBACK * knockbackScale;
      this.velocity.y = Math.max(this.velocity.y, C.MOB_KNOCKBACK_UP * Math.min(1.5, knockbackScale));
    }
    if (this.health <= 0) { this.deathTimer = 0; this.ai.state = MobState.DEAD; return true; }
    this.ai.panic(fromX, fromZ);
    return false;
  }

  /** Physics + AI at the fixed step. `world` needs getBlock / isLoadedAt; `waterSim` may be null; `ctx` (hostile mobs) carries the targets and the path budget. */
  fixedUpdate(dt, world, waterSim, ctx = null) {
    const p = this.position, v = this.velocity;
    this.world = world;
    this.prevPosition.copy(p);
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.attackTimer > 0) this.attackTimer -= dt;
    if (this.isDying) {
      this.deathTimer += dt;
      if (this.deathTimer >= C.MOB_DEATH_SECONDS) this.dead = true;
      v.x *= 0.8; v.z *= 0.8;
    }
    if (!world.isLoadedAt(p.x, p.z)) { v.set(0, 0, 0); return; }

    // AI decisions a few times per second.
    if (!this.isDying) {
      this.aiTimer -= dt;
      if (this.aiTimer <= 0) { this.aiTimer += C.MOB_AI_INTERVAL; this.ai.decide(this, C.MOB_AI_INTERVAL, this.intent, ctx); }
    } else { this.intent.speed = 0; this.intent.attack = false; }

    const box = this.updateAABB();
    const feet = world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.2), Math.floor(p.z));
    const mid = world.getBlock(Math.floor(p.x), Math.floor(p.y + this.def.hitbox[1] * 0.5), Math.floor(p.z));
    this.inWater = isWater(feet) || isWater(mid);
    this.inLava = isLava(feet) || isLava(mid);

    // Movement intent → velocity (avoid walking off drops higher than MOB_MAX_DROP, and never into lava).
    let dirX = this.intent.dirX, dirZ = this.intent.dirZ, speed = this.intent.speed;
    if (speed > 0 && this.onGround && !this.inWater && !this.inLava && !this.intent.targetBelow && this._dropAhead(world, dirX, dirZ)) { speed = 0; this.stuckTimer += 0.5; }
    if (this.inWater || this.inLava) {
      // Float (slowly in lava), and paddle toward the nearest land.
      v.y += (this.inLava ? 9 : 18) * dt; if (v.y > (this.inLava ? 0.6 : 1.5)) v.y = this.inLava ? 0.6 : 1.5;
      const land = this._landDirection(world);
      if (land) { dirX = land.x; dirZ = land.z; speed = Math.max(speed, this.def.walkSpeed) * (this.inLava ? 0.4 : 1); }
      if (waterSim && this.inWater) {
        const f = waterSim.flowVector(Math.floor(p.x), Math.floor(p.y + 0.2), Math.floor(p.z), this._flow);
        v.x += f.x * C.ITEM_WATER_PUSH * dt; v.z += f.z * C.ITEM_WATER_PUSH * dt;
      }
    } else {
      v.y -= C.GRAVITY * dt;
      if (v.y < -C.TERMINAL_VELOCITY) v.y = -C.TERMINAL_VELOCITY;
    }
    const accel = this.onGround || this.inWater || this.inLava ? 10 : 2;
    const blend = 1 - Math.exp(-accel * dt);
    v.x += (dirX * speed - v.x) * blend;
    v.z += (dirZ * speed - v.z) * blend;
    if (speed > 0) this.yaw += angleDelta(Math.atan2(-dirX, -dirZ), this.yaw) * (1 - Math.exp(-8 * dt));

    // Fall tracking: from the first step falling in the air until the landing (water and lava reset it).
    if (this.inWater || this.inLava) this.fallStartY = null;
    else if (!this.onGround && v.y < 0 && this.fallStartY === null) this.fallStartY = p.y;
    const m = moveBox(world, box, v.x, v.y, v.z, dt, this._move);
    if (m.landed) {
      v.y = 0;
      if (this.fallStartY !== null) { this.lastFall = this.fallStartY - box.minY; this.justLanded = this.lastFall > 3; this.fallStartY = null; }
    }
    if (m.hitCeiling) v.y = 0;
    this.onGround = m.landed || (this.onGround && m.movedY === 0 && hasSupport(world, box));
    if (m.blockedX) v.x = 0;
    if (m.blockedZ) v.z = 0;
    // Jump up one-block steps when walking into something.
    if ((m.blockedX || m.blockedZ) && this.onGround && speed > 0 && !this.inWater && !this.inLava) {
      v.y = C.MOB_JUMP_VELOCITY;
      this.onGround = false;
    }
    if ((m.blockedX || m.blockedZ) && speed > 0) this.stuckTimer += dt; else if (speed > 0) this.stuckTimer = 0;
    p.set((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2);
    const moved = Math.hypot(m.movedX, m.movedZ);
    if (this.onGround) this.walkDistance += moved;
    this.walkTime += dt * clamp(moved / dt / this.def.walkSpeed, 0, 2.5);
    if (p.y < C.VOID_Y) this.dead = true;
  }

  /** Is the ground more than MOB_MAX_DROP blocks below the block ahead? */
  _dropAhead(world, dirX, dirZ) {
    const ax = Math.floor(this.position.x + dirX * 0.8), az = Math.floor(this.position.z + dirZ * 0.8);
    const y0 = Math.floor(this.position.y);
    // Lava ahead (at foot level or in the drop below) counts as a cliff: mobs avoid it.
    for (let dy = -1; dy <= C.MOB_MAX_DROP; dy++) { const id = world.getBlock(ax, y0 - dy, az); if (isLava(id)) return true; if (dy >= 0 && isSolidAt(world, ax, y0 - 1 - dy, az)) return false; }
    return true;
  }

  /** Direction toward nearby land (a solid column at the water surface), or null. */
  _landDirection(world) {
    const px = Math.floor(this.position.x), pz = Math.floor(this.position.z), py = Math.floor(this.position.y);
    let best = null, bestD = Infinity;
    for (let a = 0; a < 8; a++) {
      const dx = Math.round(Math.cos(a * Math.PI / 4)), dz = Math.round(Math.sin(a * Math.PI / 4));
      for (let d = 2; d <= 8; d += 2) {
        const x = px + dx * d, z = pz + dz * d;
        for (let y = py; y <= py + 1; y++) {
          if (isSolidAt(world, x, y, z) && !isWater(world.getBlock(x, y + 1, z)) && d < bestD) { bestD = d; best = { x: dx, z: dz }; }
        }
      }
    }
    if (best) { const l = Math.hypot(best.x, best.z) || 1; best.x /= l; best.z /= l; }
    return best;
  }

  /** Visual update: interpolation, leg / arm / head animation, hurt flash, death tip-over. */
  render(alpha, dt, light = 1) {
    const root = this.root;
    root.position.lerpVectors(this.prevPosition, this.position, alpha);
    root.rotation.y = this.yaw;
    const pivots = this.model.pivots;
    const swing = Math.sin(this.walkTime * 6) * 0.7 * clamp(this.velocity.length() / this.def.walkSpeed, 0, 1.3);
    if (!this._legs) this._legs = [pivots.get('leg0') || null, pivots.get('leg1') || null, pivots.get('leg2') || null, pivots.get('leg3') || null];
    const legs = this._legs;
    for (let i = 0; i < 4; i++) { const pv = legs[i]; if (pv) pv.rotation.x = (i === 0 || i === 3) ? swing : -swing; }
    // Humanoids (the zombie): legs alternate, both arms stretch forward (the Minecraft zombie pose) with a slow sway,
    // and swing down and back up over the 0.3 s after a hit.
    const leftLeg = pivots.get('leftLeg');
    if (leftLeg) {
      leftLeg.rotation.x = swing; pivots.get('rightLeg').rotation.x = -swing;
      const la = pivots.get('leftArm'), ra = pivots.get('rightArm');
      if (this.isHostile) {
        const sway = Math.sin(this.walkTime * 3) * 0.08;
        const hit = this.attackTimer > 0 ? Math.sin((1 - this.attackTimer / 0.3) * Math.PI) * 0.9 : 0; // down and back up
        la.rotation.x = Math.PI / 2 - 0.1 + sway - hit; ra.rotation.x = Math.PI / 2 - 0.1 - sway - hit;
        la.rotation.z = -0.05; ra.rotation.z = 0.05;
      } else { la.rotation.x = -swing; ra.rotation.x = swing; }
    }
    const head = pivots.get('head');
    if (head) {
      const target = this.intent.speed > 0 ? this.yaw : (this.intent.headYaw ?? this.yaw);
      this.headYaw += angleDelta(target, this.headYaw) * (1 - Math.exp(-6 * dt));
      head.rotation.y = clamp(angleDelta(this.headYaw, this.yaw), -1.2, 1.2);
    }
    // Hurt flash, then the voxel light at the mob: a cow in a cave is darker too.
    if (this.flashTimer > 0) this.flashTimer -= dt;
    const base = this.flashTimer > 0 ? HURT_RED : WHITE;
    // Material colours are written only when the light or the flash changed.
    if (base !== this._lastBase || !sameLight(light, this._lastLight)) {
      this._lastBase = base; this._lastLight = copyLight(light, this._lastLight);
      for (const m of this.model.materials) multiplyLight(m.color.copy(base), light); // a factor or [r, g, b] (sky + warm block light)
    }
    if (this.isDying) {
      const t = clamp(this.deathTimer / C.MOB_DEATH_SECONDS, 0, 1);
      root.rotation.z = (t * t * (3 - 2 * t)) * (Math.PI / 2);
      root.position.y += t * this.def.hitbox[0] * 0.5;
    } else root.rotation.z = 0;
  }

  serialize() {
    return { type: this.type, x: this.position.x, y: this.position.y, z: this.position.z, yaw: this.yaw, health: this.health };
  }
}

export { MobState };
