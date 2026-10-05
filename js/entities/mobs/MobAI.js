// MobAI.js — wander / idle / panic decisions for passive mobs. Runs a few times per second; produces a
// movement intent {dirX, dirZ, speed, headYaw} that Mob.js executes at the fixed physics step. Pure.

import { MOB_WANDER_RADIUS, MOB_PANIC_SECONDS } from '../../config/Constants.js';

export const MobState = Object.freeze({ IDLE: 'idle', WANDER: 'wander', PANIC: 'panic', DEAD: 'dead' });

export class MobAI {
  constructor(rng) {
    this.rng = rng;
    this.state = MobState.IDLE;
    this.timer = 1 + rng.next() * 4;
    this.targetX = 0; this.targetZ = 0;
    this.lookYaw = 0;
    this.lookTimer = 0;
    this.panicFromX = 0; this.panicFromZ = 0;
  }

  /** Flee from a position for MOB_PANIC_SECONDS. */
  panic(fromX, fromZ) {
    this.state = MobState.PANIC;
    this.timer = MOB_PANIC_SECONDS;
    this.panicFromX = fromX; this.panicFromZ = fromZ;
  }

  /** Called with the seconds since the last decision. Fills `intent`. */
  decide(mob, dt, intent) {
    this.timer -= dt;
    const px = mob.position.x, pz = mob.position.z;
    intent.speed = 0; intent.dirX = 0; intent.dirZ = 0;
    if (this.state === MobState.PANIC) {
      const dx = px - this.panicFromX, dz = pz - this.panicFromZ;
      const len = Math.hypot(dx, dz) || 1;
      intent.dirX = dx / len; intent.dirZ = dz / len; intent.speed = mob.def.panicSpeed;
      // Add some wobble so the flight isn't a straight line.
      const wob = Math.sin(this.timer * 5) * 0.4;
      const c = Math.cos(wob), s = Math.sin(wob);
      const rx = intent.dirX * c - intent.dirZ * s, rz = intent.dirX * s + intent.dirZ * c;
      intent.dirX = rx; intent.dirZ = rz;
      intent.headYaw = Math.atan2(-intent.dirX, -intent.dirZ);
      if (this.timer <= 0) { this.state = MobState.IDLE; this.timer = 2 + this.rng.next() * 6; }
      return;
    }
    if (this.state === MobState.WANDER) {
      const dx = this.targetX - px, dz = this.targetZ - pz;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.6 || this.timer <= 0 || mob.stuckTimer > 1.5) {
        this.state = MobState.IDLE; this.timer = 2 + this.rng.next() * 6; mob.stuckTimer = 0;
        return;
      }
      intent.dirX = dx / dist; intent.dirZ = dz / dist; intent.speed = mob.def.walkSpeed;
      intent.headYaw = Math.atan2(-intent.dirX, -intent.dirZ);
      return;
    }
    // Idle: look around now and then, occasionally start wandering.
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) { this.lookTimer = 1.5 + this.rng.next() * 3; this.lookYaw = mob.yaw + (this.rng.next() - 0.5) * 1.6; }
    intent.headYaw = this.lookYaw;
    if (this.timer <= 0) {
      const a = this.rng.next() * Math.PI * 2, r = 3 + this.rng.next() * (MOB_WANDER_RADIUS - 3);
      this.targetX = px + Math.cos(a) * r; this.targetZ = pz + Math.sin(a) * r;
      this.state = MobState.WANDER; this.timer = 4 + this.rng.next() * 6;
    }
  }
}
