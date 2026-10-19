// ZombieAI.js — the hostile mob's brain, on top of the passive wander / idle behaviour (MobAI.js): pick the nearest
// Survival player within the chase range, walk straight at it (one-block steps are jumped by the physics, drops deeper
// than MOB_MAX_DROP are avoided unless the target is below), and when the straight line is blocked ask the pathfinder
// for a route (at most twice a second, inside MobManager's time budget) and follow its cells. Within reach it asks for a
// melee hit (`intent.attack`) once per cooldown; MobManager applies the damage. Being hit makes it chase the attacker.

import { MobAI, MobState } from './MobAI.js';
import { findPath } from './Pathfinder.js';
import { ZOMBIE_PATH_INTERVAL, ZOMBIE_PATH_RADIUS } from '../../config/Constants.js';

export const HostileState = Object.freeze({ CHASE: 'chase' });

export class ZombieAI extends MobAI {
  constructor(rng) {
    super(rng);
    this.target = null;
    this.path = null;
    this.pathIndex = 0;
    this.pathTimer = 0;
    this.attackCooldown = 0;
    this.lostTimer = 0;
  }

  /** Hit by a player: no panic — remember where it came from and chase. */
  panic(fromX, fromZ) {
    this.alertX = fromX; this.alertZ = fromZ; this.alertTimer = 10;
  }

  /** The nearest target from ctx.targets ([{ id, x, y, z }], Survival players only) within the chase range, or null. */
  _pickTarget(mob, ctx) {
    const list = ctx && ctx.targets;
    if (!list || !list.length) return null;
    const px = mob.position.x, py = mob.position.y, pz = mob.position.z;
    let best = null, bestD = mob.def.chaseRange;
    for (const t of list) {
      const d = Math.hypot(t.x - px, t.z - pz);
      if (d < bestD && Math.abs(t.y - py) < 12) { bestD = d; best = t; }
    }
    return best;
  }

  /**
   * @param {import('./Mob.js').Mob} mob
   * @param {number} dt seconds since the last decision
   * @param {object} intent filled: dirX, dirZ, speed, headYaw, attack (bool), targetBelow (bool), targetId
   * @param {{ targets: Array, pathDeadline: number, pathSearched: () => void }} ctx from MobManager
   */
  decide(mob, dt, intent, ctx) {
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.pathTimer > 0) this.pathTimer -= dt;
    if (this.alertTimer > 0) this.alertTimer -= dt;
    intent.attack = false; intent.targetBelow = false; intent.targetId = null;
    const target = this._pickTarget(mob, ctx);
    if (!target) {
      this.target = null; this.path = null;
      if (this.alertTimer > 0 && this.alertX !== undefined) {
        // Walk toward where the hit came from for a while.
        const dx = this.alertX - mob.position.x, dz = this.alertZ - mob.position.z, d = Math.hypot(dx, dz);
        if (d > 1.5) { intent.dirX = dx / d; intent.dirZ = dz / d; intent.speed = mob.def.walkSpeed; intent.headYaw = Math.atan2(-intent.dirX, -intent.dirZ); return; }
      }
      if (this.state === HostileState.CHASE) { this.state = MobState.IDLE; this.timer = 1 + this.rng.next() * 3; }
      super.decide(mob, dt, intent);
      return;
    }
    this.state = HostileState.CHASE;
    this.target = target;
    intent.targetId = target.id;
    const px = mob.position.x, pz = mob.position.z;
    const dx = target.x - px, dz = target.z - pz, dist = Math.hypot(dx, dz);
    intent.targetBelow = target.y < mob.position.y - 1;
    intent.headYaw = Math.atan2(-dx, -dz);
    // In reach: stop and hit (the manager checks the cooldown too).
    const reach = mob.def.attackRange + mob.def.hitbox[0] * 0.5;
    if (dist <= reach && Math.abs(target.y - mob.position.y) < 2.5) {
      intent.speed = 0; intent.dirX = dx / (dist || 1); intent.dirZ = dz / (dist || 1);
      if (this.attackCooldown <= 0) { intent.attack = true; this.attackCooldown = mob.def.attackCooldown; }
      this.path = null;
      return;
    }
    // Blocked for a moment (or the target is above / below): ask the pathfinder, at most every ZOMBIE_PATH_INTERVAL.
    const blocked = mob.stuckTimer > 0.4 || Math.abs(target.y - mob.position.y) > 1.5;
    if (blocked && this.pathTimer <= 0 && ctx && ctx.pathDeadline !== undefined && performance.now() < ctx.pathDeadline) {
      this.pathTimer = ZOMBIE_PATH_INTERVAL;
      const sx = Math.floor(px), sy = Math.floor(mob.position.y + 0.01), sz = Math.floor(pz);
      this.path = findPath(mob.world, sx, sy, sz, Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), { radius: ZOMBIE_PATH_RADIUS, maxNodes: 320, deadline: ctx.pathDeadline });
      this.pathIndex = 0;
      if (ctx.pathSearched) ctx.pathSearched();
      if (!this.path.length) this.path = null;
      mob.stuckTimer = 0;
    }
    if (this.path) {
      // Follow the route: advance past cells already reached.
      while (this.pathIndex < this.path.length) {
        const c = this.path[this.pathIndex];
        if (Math.hypot(c[0] + 0.5 - px, c[2] + 0.5 - pz) < 0.45 && Math.abs(c[1] - mob.position.y) < 1.2) this.pathIndex++;
        else break;
      }
      if (this.pathIndex >= this.path.length) this.path = null;
      else {
        const c = this.path[this.pathIndex];
        const wx = c[0] + 0.5 - px, wz = c[2] + 0.5 - pz, wd = Math.hypot(wx, wz) || 1;
        intent.dirX = wx / wd; intent.dirZ = wz / wd; intent.speed = mob.def.walkSpeed;
        intent.targetBelow = intent.targetBelow || c[1] < mob.position.y - 1;
        return;
      }
    }
    intent.dirX = dx / (dist || 1); intent.dirZ = dz / (dist || 1); intent.speed = mob.def.walkSpeed;
  }
}
