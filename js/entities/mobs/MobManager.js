// MobManager.js — owns the live mobs: spawning for fresh chunks, restoring saved mobs when chunks load
// and stowing them when chunks unload, physics/AI ticks, rendering, combat hits, drops, sounds, saving.
// Multiplayer (Update #8): every mob has an id; the host runs AI / physics / damage and announces spawns,
// removals and hurts through hooks, while a guest (`remote`) only mirrors snapshots with interpolation.

import { Mob } from './Mob.js';
import { MobState } from './MobAI.js';
import { MOB_BY_TYPE, spawnsForChunk } from './MobSpawner.js';
import { ItemRegistry } from '../../items/ItemRegistry.js';
import { BlockRegistry } from '../../blocks/BlockRegistry.js';
import { chunkKeyString } from '../../world/ChunkCoords.js';
import { MOB_CAP, CHUNK_SIZE, MOB_HURT_FLASH_SECONDS, MOB_DEATH_SECONDS, MOB_KNOCKBACK, MOB_KNOCKBACK_UP } from '../../config/Constants.js';
import { Interpolator } from '../../net/Interpolator.js';
import { clamp } from '../../utils/MathUtils.js';

export class MobManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../../world/World.js').World} world
   * @param {Map<string, THREE.Texture>} textures entity sheets
   * @param {object} hooks { spawnItem(x,y,z,itemId,count), puff(x,y,z), playAt(name,x,y,z,volume), playStep(blockId,x,y,z) }
   */
  constructor(scene, world, textures, hooks) {
    this.scene = scene;
    this.world = world;
    this.textures = textures;
    this.hooks = hooks;
    /** @type {Mob[]} */
    this.mobs = [];
    /** chunk key → serialized mobs waiting for that chunk to load. */
    this.stored = new Map();
    this.waterSim = null;
    this.renderDistanceBlocks = 128;
    this._ray = { mob: null, distance: Infinity };
    this.nextId = 1;
    /** @type {Map<number, Mob>} */
    this.byId = new Map();
    /** Guest of a LAN server: mobs are host-authoritative (no AI / physics here). */
    this.remote = false;
    /** Host hooks (set by HostServer). */
    this.onSpawn = null;
    this.onRemove = null;
    this.onHurt = null;
  }

  clear() {
    for (const m of this.mobs) this.scene.remove(m.root);
    this.mobs.length = 0;
    this.stored.clear();
    this.byId.clear();
  }

  _add(def, x, y, z, seed, yaw, health, id = null) {
    if (this.mobs.length >= MOB_CAP && id === null) return null;
    const mob = new Mob(def, this.textures, x, y, z, seed);
    if (yaw !== undefined) mob.yaw = mob.headYaw = yaw;
    if (health !== undefined) mob.health = health;
    mob.id = id !== null ? id : this.nextId++;
    mob.interp = null;
    this.byId.set(mob.id, mob);
    this.mobs.push(mob);
    this.scene.add(mob.root);
    if (this.onSpawn && !this.remote) this.onSpawn(mob);
    return mob;
  }

  _drop(i) {
    const m = this.mobs[i];
    this.scene.remove(m.root);
    this.mobs.splice(i, 1);
    this.byId.delete(m.id);
    if (this.onRemove && !this.remote) this.onRemove(m);
  }

  // ---- Guest mirror (host-authoritative mobs) ----

  spawnRemote(d) {
    const def = MOB_BY_TYPE[d.type];
    if (!def || this.byId.has(d.id)) return null;
    return this._add(def, d.x, d.y, d.z, undefined, d.yaw, d.health, d.id);
  }

  removeById(id) {
    const m = this.byId.get(id);
    if (!m) return;
    const i = this.mobs.indexOf(m);
    if (i >= 0) this._drop(i);
  }

  /** Replace every mob with the host's list (joining). */
  deserializeRemote(list) {
    this.clear();
    if (Array.isArray(list)) for (const d of list) this.spawnRemote(d);
  }

  /** Host snapshot rows [id, x, y, z, yaw, headYaw, vx, vz] at local time `now`. */
  applySnapshot(list, now) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      const m = this.byId.get(r[0]);
      if (!m) continue;
      if (!m.interp) m.interp = new Interpolator();
      m.interp.push(now, r[1], r[2], r[3], r[6] || 0, 0, r[7] || 0, r[4], 0, r[5]);
    }
  }

  /** The host hurt (or killed) a mob: flash, knockback, sounds and particles like a local hit. */
  hurtRemote(msg) {
    const mob = this.byId.get(msg.id);
    if (!mob) return;
    mob.health = msg.health;
    mob.flashTimer = MOB_HURT_FLASH_SECONDS;
    const dx = mob.position.x - msg.fromX, dz = mob.position.z - msg.fromZ, len = Math.hypot(dx, dz) || 1;
    mob.velocity.x += (dx / len) * MOB_KNOCKBACK; mob.velocity.z += (dz / len) * MOB_KNOCKBACK; mob.velocity.y = Math.max(mob.velocity.y, MOB_KNOCKBACK_UP);
    const p = mob.position;
    this.hooks.playAt(msg.died ? mob.def.sounds.death : mob.def.sounds.hurt, p.x, p.y + 0.5, p.z, 0.9);
    if (msg.crit && this.hooks.crit) this.hooks.crit(p.x, p.y + mob.def.hitbox[1] * 0.6, p.z, mob.def.hitbox[0] * 0.5, mob.def.hitbox[1]);
    else if (!msg.crit && this.hooks.hitPuff) this.hooks.hitPuff(p.x, p.y + mob.def.hitbox[1] * 0.6, p.z);
    if (msg.died && !mob.isDying) { mob.deathTimer = 0; mob.ai.state = MobState.DEAD; this.hooks.puff(p.x, p.y + mob.def.hitbox[1] * 0.5, p.z); }
  }

  /** Guests: move every mob toward the host's snapshots (no AI, no physics). */
  _mirror(dt, player) {
    const px = player.position.x, pz = player.position.z, far = this.renderDistanceBlocks;
    const now = performance.now() / 1000;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      m.prevPosition.copy(m.position);
      if (m.interp && m.interp.hasData) {
        const o = m.interp.sample(now);
        m.position.set(o.x, o.y, o.z);
        m.yaw = o.yaw;
        m.headYaw = typeof o.extra === 'number' ? o.extra : o.yaw;
        m.velocity.set(o.vx, 0, o.vz);
        m.intent.speed = Math.hypot(o.vx, o.vz) > 0.1 ? 1 : 0;
      }
      const moved = m.position.distanceTo(m.prevPosition);
      m.walkTime += dt * clamp(moved / Math.max(1e-3, dt) / m.def.walkSpeed, 0, 2.5);
      m.updateAABB();
      if (m.invulnTimer > 0) m.invulnTimer -= dt;
      if (m.isDying) { m.deathTimer += dt; if (m.deathTimer >= MOB_DEATH_SECONDS) { this._drop(i); continue; } }
      m.frozen = Math.hypot(m.position.x - px, m.position.z - pz) > far;
      m.root.visible = !m.frozen;
    }
  }

  /** First-time spawns for a freshly generated chunk. */
  spawnForChunk(seed, chunk) {
    for (const s of spawnsForChunk(seed, chunk)) this._add(MOB_BY_TYPE[s.type], s.x, s.y, s.z, s.seed);
  }

  /** Restore mobs saved in this chunk. */
  onChunkLoaded(cx, cz) {
    if (this.remote) return;
    const key = chunkKeyString(cx, cz);
    const list = this.stored.get(key);
    if (!list) return;
    this.stored.delete(key);
    for (const d of list) { const def = MOB_BY_TYPE[d.type]; if (def) this._add(def, d.x, d.y, d.z, undefined, d.yaw, d.health); }
  }

  /** Stow live mobs of an unloading chunk so they come back later. */
  onChunkUnloading(cx, cz) {
    if (this.remote) return; // the host decides which mobs exist
    const key = chunkKeyString(cx, cz);
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      if ((Math.floor(m.position.x) >> 4) !== cx || (Math.floor(m.position.z) >> 4) !== cz) continue;
      if (!m.isDying) { if (!this.stored.has(key)) this.stored.set(key, []); this.stored.get(key).push(m.serialize()); }
      this._drop(i);
    }
  }

  /** Hit a mob with damage from the player's position; `crit` adds the star burst and the sharper sound. */
  hit(mob, damage, fromX, fromZ, crit = false) {
    const died = mob.hurt(damage, fromX, fromZ);
    const p = mob.position;
    this.hooks.playAt(died ? mob.def.sounds.death : mob.def.sounds.hurt, p.x, p.y + 0.5, p.z, 0.9);
    if (crit && this.hooks.crit) this.hooks.crit(p.x, p.y + mob.def.hitbox[1] * 0.6, p.z, mob.def.hitbox[0] * 0.5, mob.def.hitbox[1]);
    else if (!crit && this.hooks.hitPuff) this.hooks.hitPuff(p.x, p.y + mob.def.hitbox[1] * 0.6, p.z);
    if (died) {
      this.hooks.puff(p.x, p.y + mob.def.hitbox[1] * 0.5, p.z);
      for (const drop of mob.def.drops) {
        const n = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
        const id = ItemRegistry.idOf(drop.item);
        for (let i = 0; i < n; i++) this.hooks.spawnItem(p.x, p.y + 0.4, p.z, id, 1);
      }
    }
    if (this.onHurt) this.onHurt(mob, died, crit, fromX, fromZ);
    return died;
  }

  /** Closest mob along a ray (slab test against each AABB) within maxDistance, or null. */
  raycast(ox, oy, oz, dx, dy, dz, maxDistance) {
    let best = null, bestT = maxDistance;
    for (const m of this.mobs) {
      if (m.isDying || m.frozen) continue;
      const b = m.aabb;
      let tmin = 0, tmax = bestT, ok = true;
      const axes = [[ox, dx, b.minX, b.maxX], [oy, dy, b.minY, b.maxY], [oz, dz, b.minZ, b.maxZ]];
      for (const [o, d, lo, hi] of axes) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } continue; }
        let t1 = (lo - o) / d, t2 = (hi - o) / d;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { ok = false; break; }
      }
      if (ok && tmin < bestT) { bestT = tmin; best = m; }
    }
    this._ray.mob = best; this._ray.distance = bestT;
    return best ? this._ray : null;
  }

  fixedUpdate(dt, player) {
    if (this.remote) { this._mirror(dt, player); return; }
    const px = player.position.x, pz = player.position.z;
    const far = this.renderDistanceBlocks;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      const d = Math.hypot(m.position.x - px, m.position.z - pz);
      m.frozen = d > far;
      m.root.visible = !m.frozen;
      if (m.frozen) continue;
      const wasGround = m.walkDistance;
      m.fixedUpdate(dt, this.world, this.waterSim);
      if (m.dead) { this._drop(i); continue; }
      // Quiet footsteps on the block underneath.
      if (m.onGround && m.walkDistance - m.lastStepDistance > 0.7) {
        m.lastStepDistance = m.walkDistance;
        const under = this.world.getBlock(Math.floor(m.position.x), Math.floor(m.position.y - 0.05), Math.floor(m.position.z));
        if (under) this.hooks.playStep(under, m.position.x, m.position.y, m.position.z);
      }
      void wasGround;
      // Ambient calls.
      if (!m.isDying) {
        m.ambientTimer -= dt;
        if (m.ambientTimer <= 0) {
          m.ambientTimer = 8 + Math.random() * 17;
          this.hooks.playAt(m.def.sounds.ambient, m.position.x, m.position.y + 0.5, m.position.z, 0.7);
        }
      }
    }
  }

  render(alpha, dt) {
    for (const m of this.mobs) if (!m.frozen) m.render(alpha, dt);
  }

  setRenderDistance(chunks) { this.renderDistanceBlocks = chunks * CHUNK_SIZE; }

  serialize() {
    const out = this.mobs.filter((m) => !m.isDying).map((m) => m.serialize());
    for (const list of this.stored.values()) out.push(...list);
    return out;
  }

  /** Load saved mobs; they appear when their chunk loads. */
  deserialize(list) {
    this.clear();
    if (!Array.isArray(list)) return;
    for (const d of list) {
      if (!MOB_BY_TYPE[d.type]) continue;
      const key = chunkKeyString(Math.floor(d.x) >> 4, Math.floor(d.z) >> 4);
      if (!this.stored.has(key)) this.stored.set(key, []);
      this.stored.get(key).push(d);
    }
  }
}

export { BlockRegistry };
