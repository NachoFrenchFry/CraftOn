// MobManager.js — owns the live mobs: spawning for fresh chunks, restoring saved mobs when chunks load
// and stowing them when chunks unload, physics/AI ticks, rendering, combat hits, drops, sounds, saving.
// Hostile mobs (zombies): spawned by the darkness spawner (light 0 at the feet and head, 24–64 blocks from a player,
// a cap per player separate from the passive one), despawned far away, dropped with their chunk and never saved;
// their melee hits reach players through the `hurtPlayer` hook (the host applies and relays them).
// Multiplayer: every mob has an id; the host runs AI / physics / damage and announces spawns,
// removals and hurts through hooks, while a guest (`remote`) only mirrors snapshots with interpolation.

import { Sphere } from 'three';
import { rayBox } from '../../utils/RayBox.js';
import { Mob } from './Mob.js';
import { MobState } from './MobAI.js';
import { MOB_BY_TYPE, spawnsForChunk } from './MobSpawner.js';
import { LAVA_DAMAGE, LAVA_DAMAGE_INTERVAL, FIRE_SECONDS, FIRE_DAMAGE, FIRE_INTERVAL } from '../../player/Damage.js';
import { ItemRegistry } from '../../items/ItemRegistry.js';
import { BlockRegistry } from '../../blocks/BlockRegistry.js';
import { chunkKeyString } from '../../world/ChunkCoords.js';
import { MOB_CAP, CHUNK_SIZE, MOB_HURT_FLASH_SECONDS, MOB_DEATH_SECONDS, MOB_KNOCKBACK, MOB_KNOCKBACK_UP, MOB_RESPAWN_SECONDS, MOB_RESPAWN_MIN_DISTANCE, MOB_RESPAWN_MIN_SKY_LIGHT, MOB_GROUP_MIN, MOB_GROUP_MAX,
  HOSTILE_CAP_PER_PLAYER, HOSTILE_SPAWN_INTERVAL, HOSTILE_SPAWN_ATTEMPTS, HOSTILE_SPAWN_MIN_DISTANCE, HOSTILE_SPAWN_MAX_DISTANCE, HOSTILE_GROUP_MIN, HOSTILE_GROUP_MAX,
  HOSTILE_DESPAWN_DISTANCE, HOSTILE_DESPAWN_SOFT_DISTANCE, HOSTILE_DESPAWN_CHANCE, ZOMBIE_PATH_BUDGET_MS, MIN_CAVE_Y, WORLD_HEIGHT } from '../../config/Constants.js';
import { SOLID } from '../../blocks/BlockRegistry.js';
import { isLiquid } from '../../world/WaterLevels.js';
import { standable } from './Pathfinder.js';
import { HOSTILE_TYPES } from './MobSpawner.js';
import { mobFallDamage } from '../../player/Damage.js';
import { BlockIds } from '../../blocks/BlockIds.js';
import { MOB_TYPES } from './MobSpawner.js';
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
    this._sphere = new Sphere();
    this.mobs = [];
    /** chunk key → serialized mobs waiting for that chunk to load. */
    this.stored = new Map();
    this.waterSim = null;
    this.renderDistanceBlocks = 128;
    /** (x, y, z) → brightness factor of the sky light there, set by Game. */
    this.lightAt = null;
    /** mobs farther than this freeze (simulation distance) / are hidden (entity distance). */
    this.simDistanceBlocks = 96;
    this.entityDistanceBlocks = 128;
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
    /**
     * Natural respawning: every MOB_RESPAWN_SECONDS while under the cap; () => [{ id, x, y, z, dirX, dirZ, mode, dead }] of every
     * player (set by Game): the zombies pick their targets (Survival, alive) and keep their distance from all of them.
     */
    this.respawnTimer = MOB_RESPAWN_SECONDS;
    this.playerPositions = null;
    this.respawns = 0;
    /** Hostile mobs: the world setting (false despawns every zombie and stops the spawner), the spawn round timer, the despawn roll timer. */
    this.hostileEnabled = true;
    this.hostileTimer = HOSTILE_SPAWN_INTERVAL;
    this.despawnTimer = 1;
    this.hostileSpawns = 0;
    /** (targetId, damage, kx, kz, mob) → the player took a zombie hit: 'self' is the local player, else a guest's id (set by Game). */
    this.hurtPlayer = null;
    this._ctx = { targets: [], pathDeadline: 0, pathSearched: null, searches: 0 };
  }

  /** Loaded hostile mobs. */
  get hostileCount() { let n = 0; for (const m of this.mobs) if (m.isHostile && !m.isDying) n++; return n; }
  get passiveCount() { let n = 0; for (const m of this.mobs) if (!m.isHostile) n++; return n; }

  /** The "Hostile mobs" world setting: off removes every zombie at once. */
  setHostileEnabled(on) {
    this.hostileEnabled = !!on;
    if (!on) for (let i = this.mobs.length - 1; i >= 0; i--) if (this.mobs[i].isHostile) this._drop(i);
  }

  clear() {
    for (const m of this.mobs) this.scene.remove(m.root);
    this.mobs.length = 0;
    this.stored.clear();
    this.byId.clear();
  }

  _add(def, x, y, z, seed, yaw, health, id = null) {
    if (id === null) {
      if (def.hostile) { if (!this.hostileEnabled || this.hostileCount >= this._hostileCap()) return null; }
      else if (this.passiveCount >= MOB_CAP) return null;
    }
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

  /** Show or hide a mob: a hidden one leaves the scene entirely (no matrix walk or projection for mobs beyond the entity distance). */
  _show(m, on) {
    if (m.root.visible === on && (on ? m.root.parent === this.scene : m.root.parent === null)) return;
    m.root.visible = on;
    if (on) { if (m.root.parent !== this.scene) this.scene.add(m.root); }
    else if (m.root.parent) this.scene.remove(m.root);
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
    const dx = mob.position.x - msg.fromX, dz = mob.position.z - msg.fromZ, len = Math.hypot(dx, dz) || 1, kb = msg.kb > 0 ? Math.min(3, msg.kb) : 1;
    mob.velocity.x += (dx / len) * MOB_KNOCKBACK * kb; mob.velocity.z += (dz / len) * MOB_KNOCKBACK * kb; mob.velocity.y = Math.max(mob.velocity.y, MOB_KNOCKBACK_UP * Math.min(1.5, kb));
    if (mob.isHostile && mob.ai && mob.ai.panic) mob.ai.panic(msg.fromX, msg.fromZ);
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
      const d = Math.hypot(m.position.x - px, m.position.z - pz);
      m.frozen = d > far;
      this._show(m, !m.frozen && d <= this.entityDistanceBlocks);
    }
  }

  /** First-time spawns for a freshly generated chunk. */
  spawnForChunk(seed, chunk) {
    for (const s of spawnsForChunk(seed, chunk)) this._add(MOB_BY_TYPE[s.type], s.x, s.y, s.z, s.seed);
  }

  _hostileCap() { const players = this.playerPositions ? Math.max(1, this.playerPositions().length) : 1; return HOSTILE_CAP_PER_PLAYER * players; }

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
      if (!m.isDying && !m.isHostile) { if (!this.stored.has(key)) this.stored.set(key, []); this.stored.get(key).push(m.serialize()); } // zombies despawn with their chunk
      this._drop(i);
    }
  }

  /** Hit a mob with damage from the player's position; `crit` adds the star burst and the sharper sound. */
  hit(mob, damage, fromX, fromZ, crit = false, knockback = true, knockbackScale = 1) {
    const died = mob.hurt(damage, fromX, fromZ, knockback, knockbackScale);
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
    if (this.onHurt) this.onHurt(mob, died, crit, fromX, fromZ, knockbackScale);
    return died;
  }

  /** Closest mob along a ray (slab test against each AABB) within maxDistance, or null. */
  raycast(ox, oy, oz, dx, dy, dz, maxDistance) {
    let best = null, bestT = maxDistance;
    for (const m of this.mobs) {
      if (m.isDying || m.frozen) continue;
      const b = m.aabb;
      const t = rayBox(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, bestT);
      if (t >= 0 && t < bestT) { bestT = t; best = m; }
    }
    this._ray.mob = best; this._ray.distance = bestT;
    return best ? this._ray : null;
  }

  fixedUpdate(dt, player) {
    if (this.remote) { this._mirror(dt, player); return; }
    const px = player.position.x, pz = player.position.z;
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) { this.respawnTimer = MOB_RESPAWN_SECONDS; this.tryRespawn(px, pz); }
    const players = this.playerPositions ? this.playerPositions() : [{ id: 'self', x: player.position.x, y: player.position.y, z: player.position.z, mode: player.gameMode, dead: player.dead }];
    // Hostile spawn rounds (every second per player) and the far-away despawn roll (once a second).
    this.hostileTimer -= dt;
    if (this.hostileTimer <= 0) { this.hostileTimer = HOSTILE_SPAWN_INTERVAL; if (this.hostileEnabled) for (const pl of players) this.trySpawnHostile(pl, players); }
    this.despawnTimer -= dt;
    const despawnRoll = this.despawnTimer <= 0;
    if (despawnRoll) this.despawnTimer = 1;
    // The zombies' targets: Survival players that are alive; every pathfinder search of this step shares one time budget.
    const ctx = this._ctx;
    ctx.targets.length = 0;
    for (const pl of players) if (pl.mode === 'survival' && !pl.dead) ctx.targets.push(pl);
    ctx.pathDeadline = performance.now() + ZOMBIE_PATH_BUDGET_MS;
    ctx.searches = 0;
    if (!ctx.pathSearched) ctx.pathSearched = () => { ctx.searches++; };
    const far = Math.min(this.renderDistanceBlocks, this.simDistanceBlocks);
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      const d = Math.hypot(m.position.x - px, m.position.z - pz);
      if (m.isHostile && !m.isDying) {
        // Despawn: farther than the hard distance from every player at once, a small chance each second in the soft band.
        let nearest = Infinity;
        for (const pl of players) nearest = Math.min(nearest, Math.hypot(m.position.x - pl.x, m.position.z - pl.z));
        if (nearest > HOSTILE_DESPAWN_DISTANCE || (despawnRoll && nearest > HOSTILE_DESPAWN_SOFT_DISTANCE && Math.random() < HOSTILE_DESPAWN_CHANCE)) { this._drop(i); continue; }
      }
      m.frozen = d > far;
      this._show(m, !m.frozen && d <= this.entityDistanceBlocks);
      if (m.frozen) continue;
      const wasGround = m.walkDistance;
      m.fixedUpdate(dt, this.world, this.waterSim, m.isHostile ? ctx : null);
      if (m.dead) { this._drop(i); continue; }
      if (m.intent.attack) { m.intent.attack = false; this._zombieAttack(m, players); }
      if (m.justLanded) { m.justLanded = false; const dmg = Math.round(mobFallDamage(m.lastFall) * 10) / 10; if (dmg > 0) { m.invulnTimer = 0; this.hit(m, dmg, m.position.x, m.position.z, false, false); } }
      if (m.dead) { this._drop(i); continue; }
      this._lavaAndFire(m, dt);
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
          const amb = m.def.ambientInterval || [8, 25];
          m.ambientTimer = amb[0] + Math.random() * (amb[1] - amb[0]);
          this.hooks.playAt(m.def.sounds.ambient, m.position.x, m.position.y + 0.5, m.position.z, 0.7);
        }
      }
    }
  }

  /** A zombie in reach of its target: the arm swing and the hit (15 before armor) through the hurtPlayer hook, with knockback away from the zombie. */
  _zombieAttack(m, players) {
    const target = players.find((pl) => pl.id === m.intent.targetId && pl.mode === 'survival' && !pl.dead);
    if (!target) return;
    const dx = target.x - m.position.x, dz = target.z - m.position.z, d = Math.hypot(dx, dz);
    if (d > m.def.attackRange + m.def.hitbox[0] * 0.5 + 0.3 || Math.abs(target.y - m.position.y) > 2.5) return;
    m.attackTimer = 0.3;
    if (this.hurtPlayer) this.hurtPlayer(target.id, m.def.attackDamage, dx / (d || 1), dz / (d || 1), m);
  }

  /**
   * One spawn round for a player (host only): HOSTILE_SPAWN_ATTEMPTS random columns 24–64 blocks away; in each, a few random
   * heights from the cave floor to the surface are tested for a spawn spot — a solid full block to stand on, two
   * non-solid, non-liquid blocks above, sky light 0 and block light 0 at the feet and the head, at least 24 blocks from
   * every player — and a group of 1–4 zombies appears around the first spot found. Reads the light arrays only; a round
   * costs a few dozen block lookups.
   */
  trySpawnHostile(center, players, rng = Math.random) {
    if (this.remote || !this.hostileEnabled || center.mode === 'spectator') return 0;
    if (this.hostileCount >= this._hostileCap()) return 0;
    const w = this.world;
    for (let attempt = 0; attempt < HOSTILE_SPAWN_ATTEMPTS; attempt++) {
      const a = rng() * Math.PI * 2, dist = HOSTILE_SPAWN_MIN_DISTANCE + rng() * (HOSTILE_SPAWN_MAX_DISTANCE - HOSTILE_SPAWN_MIN_DISTANCE);
      const x = Math.floor(center.x + Math.cos(a) * dist), z = Math.floor(center.z + Math.sin(a) * dist);
      if (!w.isLoadedAt(x, z)) continue;
      const top = w.getTopY(x, z);
      if (top < 0) continue;
      // Heights to try: the surface and three random cave levels between the cave floor and the surface.
      const ys = [top + 1];
      for (let k = 0; k < 3; k++) ys.push(MIN_CAVE_Y + Math.floor(rng() * Math.max(1, top - MIN_CAVE_Y)));
      for (const y of ys) {
        if (!this._darkSpot(x, y, z) || !this._farFromPlayers(x + 0.5, z + 0.5, players)) continue;
        const def = HOSTILE_TYPES[Math.floor(rng() * HOSTILE_TYPES.length)];
        const count = HOSTILE_GROUP_MIN + Math.floor(rng() * (HOSTILE_GROUP_MAX - HOSTILE_GROUP_MIN + 1));
        let spawned = 0;
        for (let k = 0; k < count * 3 && spawned < count; k++) {
          const sx = x + (k === 0 ? 0 : Math.floor(rng() * 7) - 3), sz = z + (k === 0 ? 0 : Math.floor(rng() * 7) - 3);
          let sy = -1;
          for (let dy = 1; dy >= -2 && sy < 0; dy--) if (this._darkSpot(sx, y + dy, sz)) sy = y + dy;
          if (sy < 0 || !this._farFromPlayers(sx + 0.5, sz + 0.5, players)) continue;
          if (this._add(def, sx + 0.5, sy, sz + 0.5, Math.floor(rng() * 0xffffffff), rng() * Math.PI * 2, def.health)) spawned++;
        }
        this.hostileSpawns += spawned;
        return spawned;
      }
    }
    return 0;
  }

  /** A zombie spawn spot: standable (solid full block below, two free non-liquid blocks) and no light at all at the feet and the head. */
  _darkSpot(x, y, z) {
    const w = this.world;
    if (y < 1 || y > WORLD_HEIGHT - 3 || !standable(w, x, y, z)) return false;
    if (SOLID[w.getBlock(x, y + 1, z)] === 1 || isLiquid(w.getBlock(x, y, z)) || isLiquid(w.getBlock(x, y + 1, z))) return false;
    return w.getSkyLight(x, y, z) === 0 && w.getBlockLight(x, y, z) === 0 && w.getSkyLight(x, y + 1, z) === 0 && w.getBlockLight(x, y + 1, z) === 0;
  }

  _farFromPlayers(x, z, players) {
    for (const pl of players) if (Math.hypot(x - pl.x, z - pl.z) < HOSTILE_SPAWN_MIN_DISTANCE) return false;
    return true;
  }

  /**
   * Natural respawning (host only): every MOB_RESPAWN_SECONDS, while fewer than MOB_CAP mobs are
   * loaded, try to put a group of 3–5 of one type on grass under the sky (sky light ≥ 9) at least 24 blocks from
   * every player, preferably behind them. Returns the number spawned (0 when nothing qualified).
   */
  tryRespawn(centerX, centerZ, rng = Math.random) {
    if (this.remote || this.passiveCount >= MOB_CAP) return 0;
    const players = this.playerPositions ? this.playerPositions() : [{ x: centerX, y: 0, z: centerZ, dirX: 0, dirZ: -1 }];
    const far = Math.max(MOB_RESPAWN_MIN_DISTANCE + 8, this.simDistanceBlocks);
    let spot = null, fallback = null;
    for (let attempt = 0; attempt < 24 && !spot; attempt++) {
      const a = rng() * Math.PI * 2, d = MOB_RESPAWN_MIN_DISTANCE + rng() * (far - MOB_RESPAWN_MIN_DISTANCE);
      const x = Math.floor(centerX + Math.cos(a) * d), z = Math.floor(centerZ + Math.sin(a) * d);
      if (!this.world.isLoadedAt(x, z)) continue;
      const top = this.world.getTopY(x, z);
      if (top < 0 || this.world.getBlock(x, top, z) !== BlockIds.GRASS_BLOCK) continue;
      if (this.world.getBlock(x, top + 1, z) !== BlockIds.AIR || this.world.getBlock(x, top + 2, z) !== BlockIds.AIR) continue;
      if (this.world.getSkyLight(x, top + 1, z) < MOB_RESPAWN_MIN_SKY_LIGHT) continue;
      let tooClose = false, inView = false;
      for (const p of players) {
        const dx = x + 0.5 - p.x, dz = z + 0.5 - p.z, dist = Math.hypot(dx, dz);
        if (dist < MOB_RESPAWN_MIN_DISTANCE) { tooClose = true; break; }
        if (dist > 0 && (dx * (p.dirX || 0) + dz * (p.dirZ || 0)) / dist > 0.3) inView = true;
      }
      if (tooClose) continue;
      const candidate = { x, y: top + 1, z };
      if (!inView) spot = candidate; else if (!fallback) fallback = candidate;
    }
    spot = spot || fallback;
    if (!spot) return 0;
    const def = MOB_TYPES[Math.floor(rng() * MOB_TYPES.length)];
    const count = MOB_GROUP_MIN + Math.floor(rng() * (MOB_GROUP_MAX - MOB_GROUP_MIN + 1));
    let spawned = 0;
    for (let k = 0; k < count * 4 && spawned < count && this.passiveCount < MOB_CAP; k++) {
      const x = spot.x + Math.floor(rng() * 7) - 3, z = spot.z + Math.floor(rng() * 7) - 3;
      if (players.some((p) => Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) < MOB_RESPAWN_MIN_DISTANCE)) continue; // the whole group keeps the distance, not only its centre
      const top = this.world.getTopY(x, z);
      if (top < 0 || Math.abs(top + 1 - spot.y) > 2 || this.world.getBlock(x, top, z) !== BlockIds.GRASS_BLOCK) continue;
      if (this.world.getBlock(x, top + 1, z) !== BlockIds.AIR || this.world.getBlock(x, top + 2, z) !== BlockIds.AIR) continue;
      if (this._add(def, x + 0.5, top + 1, z + 0.5, Math.floor(rng() * 0xffffffff))) spawned++;
    }
    this.respawns += spawned;
    return spawned;
  }

  /** Lava: the same numbers as the player (20 every 0.5 s in lava, then 5 s on fire at 5 per second; water puts it out). */
  _lavaAndFire(m, dt) {
    if (m.isDying) { m.fireTimer = 0; return; }
    const p = m.position;
    if (m.inLava) {
      m.fireTimer = FIRE_SECONDS;
      m.lavaTimer -= dt;
      if (m.lavaTimer <= 0) { m.lavaTimer = LAVA_DAMAGE_INTERVAL; m.invulnTimer = 0; this.hit(m, LAVA_DAMAGE, p.x, p.z, false, false); }
    } else m.lavaTimer = 0;
    if (m.inWater) m.fireTimer = 0;
    if (m.fireTimer > 0) {
      m.fireTimer -= dt;
      if (!m.inLava) { m.burnTick -= dt; if (m.burnTick <= 0) { m.burnTick = FIRE_INTERVAL; m.invulnTimer = 0; this.hit(m, FIRE_DAMAGE, p.x, p.z, false, false); } }
    } else m.burnTick = 0;
  }

  /** Per frame: animate the mobs that can be seen (off-screen and far mobs skip the animation; their physics still runs). */
  render(alpha, dt, frustum = null) {
    const sphere = this._sphere;
    for (const m of this.mobs) {
      if (m.frozen || !m.root.visible) continue;
      if (frustum) {
        sphere.center.set(m.position.x, m.position.y + m.def.hitbox[1] * 0.5, m.position.z);
        sphere.radius = Math.max(m.def.hitbox[0], m.def.hitbox[1]) + 0.5;
        if (!frustum.intersectsSphere(sphere)) continue;
      }
      m.render(alpha, dt, this.lightAt ? this.lightAt(m.position.x, m.position.y + 0.5, m.position.z) : 1);
      if (m.fireTimer > 0 && this.hooks.flame) this.hooks.flame(m.root.position.x, m.root.position.y + m.def.hitbox[1] * 0.6, m.root.position.z, 1);
    }
  }

  setRenderDistance(chunks) { this.renderDistanceBlocks = chunks * CHUNK_SIZE; }
  setSimulationDistance(blocks) { this.simDistanceBlocks = blocks; }
  setEntityDistance(blocks) { this.entityDistanceBlocks = blocks; }

  /** Saved mobs: the passive ones that are alive, plus the stowed ones; zombies are never saved. */
  serialize() {
    const out = this.mobs.filter((m) => !m.isDying && !m.isHostile).map((m) => m.serialize());
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
