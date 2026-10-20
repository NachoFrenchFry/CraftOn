// EntityManager.js — owns item entities (spawning, physics ticks, pickup, merging, rendering), the arrows (ArrowEntity:
// swept flight, block / mob / player hits, sticking, pickup) and the primed explosives (PrimedExplosive: the fuse, then
// Explosion.js: block destruction as one batch, drops, damage with exposure, knockback, chain reactions). In multiplayer
// every entity has an id; the host spawns / removes them and tells everyone through hooks, while a guest (`remote`)
// mirrors them (arrows and explosives fly with the same local physics), asks the host to pick up items
// (item:pickupRequest) and throws / shoots / primes through the host.

import { ItemRegistry } from '../items/ItemRegistry.js';
import * as THREE from 'three';
import { ItemEntity } from './ItemEntity.js';
import { ArrowEntity } from './ArrowEntity.js';
import { PrimedExplosive } from './PrimedExplosive.js';
import { explosionBlocks, explosionImpactOn } from './Explosion.js';
import { createBlockModelMaterial, createBlockModelMaterialTranslucent } from '../rendering/Materials.js';
import { PASS, RenderPass, SOLID, RENDER_TYPE, RenderType, BlockRegistry } from '../blocks/BlockRegistry.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { ITEM_PICKUP_DELAY, ITEM_THROW_PICKUP_DELAY, ITEM_PICKUP_EXPAND_XZ, ITEM_PICKUP_EXPAND_Y, ARROW_SPEED, ARROW_BASE_DAMAGE, EXPLOSION_POWER, EXPLOSION_DROP_CHANCE, EXPLOSIONS_PER_STEP, EXPLOSIVE_CHAIN_FUSE_MIN, EXPLOSIVE_CHAIN_FUSE_MAX, EXPLOSION_KNOCKBACK, PLAYER_WIDTH, PLAYER_HEIGHT } from '../config/Constants.js';
import { ITEM_HALF } from './ItemEntity.js';
import { arrowMobDamage, explosionMobDamage } from '../player/Damage.js';
import { ItemIds } from '../items/ItemDefinitions.js';

import { rayBox as rayBoxT } from '../utils/RayBox.js';

const MERGE_RANGE = 0.75;
/** A stuck arrow is picked up when the shooter's box, grown by this much, touches it. */
const ARROW_PICKUP_EXPAND = 0.6;

export class EntityManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/World.js').World} world
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} atlas
   * @param {import('../player/Player.js').Player} player
   * @param {import('../items/Inventory.js').Inventory} inventory
   * @param {import('../core/EventBus.js').EventBus} events
   */
  constructor(scene, world, atlas, player, inventory, events) {
    this.scene = scene;
    this.world = world;
    this.atlas = atlas;
    this.player = player;
    this.inventory = inventory;
    this.events = events;
    /** Set by Game so dropped items drift in flowing water. */
    this.waterSim = null;
    /** @type {import('./mobs/MobManager.js').MobManager|null} set by Game once the mob textures loaded */
    this.mobs = null;
    this.material = createBlockModelMaterial(atlas.texture);
    this.materialTranslucent = createBlockModelMaterialTranslucent(atlas.texture);
    /** @type {ItemEntity[]} */
    this.items = [];
    this.time = 0;
    this._tmp = new THREE.Vector3();
    this.nextId = 1;
    /** @type {Map<number, ItemEntity>} */
    this.byId = new Map();
    /** Guest of a LAN server: items are host-authoritative. */
    this.remote = false;
    /** items farther than this do not update (simulation distance) / are hidden (entity distance). */
    this.simDistanceBlocks = Infinity;
    this.entityDistanceBlocks = Infinity;
    /** (x, y, z) → brightness factor of the sky light there, set by Game. */
    this.lightAt = null;
    /** (x, y, z) an item burned in lava: Game plays the sizzle. */
    this.onBurn = null;
    /** Host hooks (set by HostServer): broadcast spawns and removals. */
    this.onSpawn = null;
    this.onRemove = null;
    /** Guest hook: throwing goes through the host instead of spawning locally. */
    this.throwHook = null;
    /** @type {ArrowEntity[]} */
    this.arrows = [];
    /** @type {PrimedExplosive[]} */
    this.explosives = [];
    this.arrowMaterial = null;
    this.nextArrowId = 1;
    this.nextExplosiveId = 1;
    /** Explosions waiting for a physics step (at most EXPLOSIONS_PER_STEP per step, so a chain never freezes a frame). */
    this.explosionQueue = [];
    /** Set by Game: the entity sheets (the arrow texture), the voxel ray helper, the mobs, the remote players, world settings and the effect / damage callbacks. */
    this.entityTextures = null;
    this.raycaster = null;
    this.remotePlayers = null;
    this.explosionsBreakBlocks = true;
    /** (shooter, hit) → damage a player: hit = { id ('self' | userId), damage, crit, kx, kz, kind: 'arrow' | 'explosion', by } (set by Game). */
    this.hurtPlayer = null;
    /** Effects (set by Game): sounds and particles at positions. */
    this.effects = null;
    /** Host hooks for arrows and explosives (HostServer). */
    this.onArrowSpawn = null; this.onArrowStuck = null; this.onArrowRemove = null;
    this.onExplosiveSpawn = null; this.onExplosion = null;
    /** True while an explosion removes its blocks (HostServer tags the batch). */
    this.exploding = false;
    /** Statistics for tests. */
    this.explosions = 0; this.arrowsShot = 0;
    this._box = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }

  /** Remove every arrow and primed explosive (not saved with the world). */
  clearProjectiles() {
    for (const a of this.arrows) { this.scene.remove(a.mesh); a.dispose(); }
    for (const e of this.explosives) this.scene.remove(e.group);
    this.arrows.length = 0; this.explosives.length = 0; this.explosionQueue.length = 0;
  }

  /** Remove every dropped item (and nothing else): what loading a world's item list replaces. */
  clearItems() {
    for (const it of this.items) { this.scene.remove(it.group); it.mesh.material.dispose(); }
    this.items.length = 0;
    this.byId.clear();
  }

  /** Remove everything — items, projectiles and mobs. Only for leaving or resetting a world (WorldSession); never while loading one. */
  clear() {
    this.clearItems();
    this.clearProjectiles();
    if (this.mobs) this.mobs.clear();
  }

  /** Remove an item at once (host grant, guest mirror). */
  removeEntity(it) {
    if (!it || it.dead) return;
    it.dead = true;
    const i = this.items.indexOf(it);
    if (i >= 0) this.items.splice(i, 1);
    this._dropped(it);
  }

  removeById(id) { const it = this.byId.get(id); if (it) this.removeEntity(it); }

  _dropped(it) {
    this.scene.remove(it.group);
    it.mesh.material.dispose();
    if (it.id !== null) { this.byId.delete(it.id); if (this.onRemove && !this.remote) this.onRemove(it); }
  }

  /** Host snapshot of item positions (guests): keeps mirrored items where the host has them. */
  applySnapshot(list) {
    if (!Array.isArray(list)) return;
    for (const row of list) {
      const it = this.byId.get(row[0]);
      if (!it) continue;
      it.prevPosition.copy(it.position);
      it.position.set(row[1], row[2], row[3]);
    }
  }

  /**
   * Spawn an item with a small random pop velocity. `id` is the host's id for mirrored items; on the host every
   * item gets one; a guest's purely local items (crafting leftovers) have none and are picked up locally.
   */
  spawnItem(x, y, z, itemId, count, vx = null, vy = null, vz = null, pickupDelay = ITEM_PICKUP_DELAY, id = null) {
    const mat = (PASS[itemId] === RenderPass.TRANSLUCENT ? this.materialTranslucent : this.material).clone(); // per item: its colour follows the light where it lies
    const ivx = vx ?? (Math.random() - 0.5) * 2.5;
    const ivy = vy ?? 3 + Math.random() * 1.5;
    const ivz = vz ?? (Math.random() - 0.5) * 2.5;
    const it = new ItemEntity(this.world, mat, this.atlas, itemId, count, x, y, z, ivx, ivy, ivz, pickupDelay);
    it.waterSim = this.waterSim;
    it.id = id !== null ? id : this.remote ? null : this.nextId++;
    it.requestTimer = 0;
    if (it.id !== null) this.byId.set(it.id, it);
    this.items.push(it);
    this.scene.add(it.group);
    if (this.onSpawn && !this.remote && it.id !== null) this.onSpawn(it);
    return it;
  }

  /** Throw an item from the player's eyes along the look direction (Q). Guests ask the host to spawn it. */
  throwFromPlayer(itemId, count) {
    const p = this.player;
    const eye = p.getEyePosition(this._tmp);
    const dir = new THREE.Vector3();
    p.getLookDirection(dir);
    const x = eye.x + dir.x * 0.5, y = eye.y - 0.3, z = eye.z + dir.z * 0.5;
    const vx = dir.x * 6 + (Math.random() - 0.5), vy = dir.y * 6 + 1.5, vz = dir.z * 6 + (Math.random() - 0.5);
    if (this.throwHook) { this.throwHook(itemId, count, x, y, z, vx, vy, vz); this.events.emit('item:thrown', null); return null; }
    const it = this.spawnItem(x, y, z, itemId, count, vx, vy, vz, ITEM_THROW_PICKUP_DELAY);
    this.events.emit('item:thrown', it);
    return it;
  }

  // ---- Arrows ----

  /**
   * The base arrow material: unlit (MeshBasicMaterial), alpha-tested, double-sided, over the arrow sheet; every arrow gets a
   * clone so its colour can follow the light where it flies. Built on the first shot and rebuilt if the sheet arrived
   * later (the existing arrows get the map too; magenta only while it is missing).
   */
  _arrowMat() {
    const tex = this.entityTextures ? this.entityTextures.get('arrow') || null : null;
    if (!this.arrowMaterial || (tex && this.arrowMaterial.map !== tex)) {
      this.arrowMaterial = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide });
      if (!tex) this.arrowMaterial.color.set(0xff00ff);
      for (const a of this.arrows) { a.mesh.material.map = tex; a.mesh.material.needsUpdate = true; if (tex) a.mesh.material.color.set(0xffffff); }
    }
    return this.arrowMaterial;
  }

  /**
   * Shoot an arrow (the host or single player): from `origin` along `dir` (unit) with draw power 0..1 → speed ARROW_SPEED × power.
   * `shooter` is 'self' for the local player or a guest's user id; `pickup` false for Creative arrows. Returns the arrow.
   */
  shootArrow(origin, dir, power, shooter = 'self', { pickup = true, id = null, remote = false, crit = null, vx = null, vy = null, vz = null } = {}) {
    const speed = ARROW_SPEED * Math.max(0.05, Math.min(1, power));
    const a = new ArrowEntity(this._arrowMat().clone(), {
      x: origin.x, y: origin.y, z: origin.z,
      vx: vx ?? dir.x * speed, vy: vy ?? dir.y * speed, vz: vz ?? dir.z * speed,
      shooter, power, crit: crit ?? power >= 1, pickup, id: id !== null ? id : this.remote ? null : this.nextArrowId++, remote,
    });
    this.arrows.push(a);
    this.scene.add(a.mesh);
    this.arrowsShot++;
    if (this.onArrowSpawn && !this.remote && a.id !== null) this.onArrowSpawn(a);
    return a;
  }

  arrowById(id) { return this.arrows.find((a) => a.id === id) || null; }

  removeArrow(a) {
    if (!a || a.dead) return;
    a.dead = true;
    const i = this.arrows.indexOf(a);
    if (i >= 0) this.arrows.splice(i, 1);
    this.scene.remove(a.mesh);
    a.dispose();
    if (this.onArrowRemove && !this.remote && a.id !== null) this.onArrowRemove(a);
  }

  /** Host correction for a mirrored arrow: it stuck at (x, y, z). */
  stickArrowAt(id, x, y, z) {
    const a = this.arrowById(id);
    if (!a) return;
    a.position.set(x, y, z); a.prevPosition.set(x, y, z); a.land();
  }

  /** The nearest thing along the segment: a block face (voxel DDA), a mob, another player or the local player (never the shooter). */
  _sweep(a, ox, oy, oz, dx, dy, dz, len) {
    let best = null, bestT = len;
    if (this.raycaster) { const t = this.raycaster.solidDistance(ox, oy, oz, dx, dy, dz, len); if (t < len) { bestT = t; best = { t, kind: 'block', target: null }; } }
    if (this.remote) return best; // guests only stop at blocks; the host decides hits
    if (this.mobs) { const h = this.mobs.raycast(ox, oy, oz, dx, dy, dz, bestT); if (h && h.distance < bestT) { bestT = h.distance; best = { t: h.distance, kind: 'mob', target: h.mob }; } }
    if (this.remotePlayers && a.age > 0.05) { const h = this.remotePlayers.raycast(ox, oy, oz, dx, dy, dz, bestT); if (h && h.player.id !== a.shooter && h.distance < bestT) { bestT = h.distance; best = { t: h.distance, kind: 'player', target: h.player }; } }
    if (a.shooter !== 'self' && a.age > 0.05 && !this.player.isSpectator && !this.player.dead) {
      const b = this.player.aabb;
      const t = rayBoxT(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, bestT);
      if (t >= 0 && t < bestT) { bestT = t; best = { t, kind: 'player', target: 'self' }; }
    }
    return best;
  }

  _updateArrows(dt) {
    const arrows = this.arrows;
    for (let i = arrows.length - 1; i >= 0; i--) {
      const a = arrows[i];
      const hit = a.fixedUpdate(dt, (ox, oy, oz, dx, dy, dz, len) => this._sweep(a, ox, oy, oz, dx, dy, dz, len));
      if (a.dead) { this.removeArrow(a); continue; }
      if (!hit) { this._arrowPickup(a); continue; }
      if (hit.kind === 'block') {
        a.land();
        if (this.effects) this.effects.arrowHitBlock(a.position.x, a.position.y, a.position.z);
        if (this.onArrowStuck && !this.remote && a.id !== null) this.onArrowStuck(a);
      } else if (hit.kind === 'mob') {
        const bonus = a.power >= 1 ? Math.floor(Math.random() * 5) : 0;
        const dmg = arrowMobDamage(a.power, bonus);
        const v = a.velocity, len = Math.hypot(v.x, v.z) || 1;
        this.mobs.hit(hit.target, dmg, hit.target.position.x - v.x / len, hit.target.position.z - v.z / len, a.crit); // knockback along the flight
        if (this.effects) this.effects.arrowHitEntity(a.position.x, a.position.y, a.position.z);
        this.removeArrow(a);
      } else {
        const bonus = a.power >= 1 ? Math.floor(Math.random() * 5) : 0;
        const v = a.velocity, len = Math.hypot(v.x, v.z) || 1;
        if (this.hurtPlayer) this.hurtPlayer(a.shooter, { id: hit.target === 'self' ? 'self' : hit.target.id, power: a.power, bonus, crit: a.crit, kx: v.x / len, kz: v.z / len, kind: 'arrow' });
        if (this.effects) this.effects.arrowHitEntity(a.position.x, a.position.y, a.position.z);
        this.removeArrow(a);
      }
    }
  }

  /** A stuck Survival arrow goes back to its shooter when they touch it (the host grants a guest's through ITEM_GRANT). */
  _arrowPickup(a) {
    if (!a.stuck || !a.pickup || this.remote || a.stuckTime < 0.5) return;
    if (a.shooter === 'self') {
      const p = this.player;
      if (p.isSpectator || p.dead) return;
      const b = p.aabb, e = ARROW_PICKUP_EXPAND, q = a.position;
      if (q.x > b.minX - e && q.x < b.maxX + e && q.y > b.minY - e && q.y < b.maxY + e && q.z > b.minZ - e && q.z < b.maxZ + e) {
        if (this.inventory.addItem(ItemIds.ARROW, 1) === 0) { this.events.emit('item:pickup', ItemIds.ARROW, 1); this.removeArrow(a); }
      }
    } else if (this.onArrowPickup) this.onArrowPickup(a); // the host checks the guest's position and grants the item
  }

  // ---- Explosives ----

  /** Prime an explosive at the block cell (x, y, z) (the host or single player); `fuse` in seconds. Returns the entity. */
  primeExplosive(x, y, z, fuse = undefined, { vx = 0, vy = 0, vz = 0, id = null, remote = false, exact = false } = {}) {
    const e = new PrimedExplosive(this.material, { x: exact ? x : x + 0.5, y, z: exact ? z : z + 0.5, vx, vy, vz, fuse, id: id !== null ? id : this.remote ? null : this.nextExplosiveId++, remote });
    this.explosives.push(e);
    this.scene.add(e.group);
    if (this.onExplosiveSpawn && !this.remote && e.id !== null) this.onExplosiveSpawn(e);
    return e;
  }

  explosiveById(id) { return this.explosives.find((e) => e.id === id) || null; }

  /** Host snapshot of primed explosive positions (guests): a mirrored one that drifted snaps back. */
  applyExplosiveSnapshot(list) {
    if (!Array.isArray(list)) return;
    for (const row of list) {
      const e = this.explosiveById(row[0]);
      if (!e) continue;
      if (Math.hypot(e.position.x - row[1], e.position.y - row[2], e.position.z - row[3]) > 0.5) { e.prevPosition.copy(e.position); e.position.set(row[1], row[2], row[3]); }
    }
  }

  removeExplosive(e) {
    const i = this.explosives.indexOf(e);
    if (i >= 0) this.explosives.splice(i, 1);
    this.scene.remove(e.group);
    e.dead = true;
  }

  /** Guest: the host's explosion of entity `id` at (x, y, z): the effects, the entity goes; the blocks arrive as a BLOCKS batch. */
  explodeRemote(id, x, y, z, power) {
    const e = id !== null && id !== undefined ? this.explosiveById(id) : null;
    if (e) this.removeExplosive(e);
    if (this.effects) this.effects.explosion(x, y, z, power);
    this.explosions++;
  }

  _updateExplosives(dt) {
    const list = this.explosives;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const done = e.fixedUpdate(dt, this.world);
      if (done && !e.remote) { this.removeExplosive(e); this.explosionQueue.push(e); }
      else if (done && e.remote && e.fuse < -1.5) this.removeExplosive(e); // the host's EXPLOSION never came (lost link): drop it quietly
    }
    let n = 0;
    while (this.explosionQueue.length && n < EXPLOSIONS_PER_STEP) { this.explode(this.explosionQueue.shift()); n++; }
  }

  /** True when a solid cube block lies on the segment from (ox, oy, oz) to (tx, ty, tz). */
  _blocked(ox, oy, oz, tx, ty, tz) {
    if (!this.raycaster) return false;
    const dx = tx - ox, dy = ty - oy, dz = tz - oz, len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return false;
    return this.raycaster.solidDistance(ox, oy, oz, dx / len, dy / len, dz / len, len) < len;
  }

  /**
   * The blast of a primed explosive (host / single player): rays destroy blocks (one batch of non-immediate block changes:
   * the mesher and the light updater take them in their budgets; drops 1 in 4; explosives blocks are primed with a short
   * fuse), entities within 2 × power take exposure-scaled damage and knockback, nearby primed explosives are pushed.
   */
  explode(e, power = EXPLOSION_POWER) {
    const cx = e.position.x, cy = e.position.y + 0.49, cz = e.position.z;
    const w = this.world;
    this.explosions++;
    if (this.explosionsBreakBlocks !== false) {
      const blocks = explosionBlocks((x, y, z) => w.getBlock(x, y, z), cx, cy, cz, power);
      this.exploding = true; // the host tags these block changes 'blast': guests apply them without per-block break effects
      for (const [x, y, z] of blocks) {
        const id = w.getBlock(x, y, z);
        if (id === BlockIds.AIR) continue;
        w.setBlock(x, y, z, BlockIds.AIR, true, false); // never an immediate remesh: the sections go dirty, one batch
        if (id === BlockIds.EXPLOSIVES) { this.primeExplosive(x, y, z, EXPLOSIVE_CHAIN_FUSE_MIN + Math.random() * (EXPLOSIVE_CHAIN_FUSE_MAX - EXPLOSIVE_CHAIN_FUSE_MIN)); continue; } // chains, never drops
        if (RENDER_TYPE[id] === RenderType.LIQUID) continue;
        if (Math.random() < EXPLOSION_DROP_CHANCE) {
          const dropName = BlockRegistry.dropName(id);
          const drop = dropName ? ItemRegistry.idOf(dropName) : -1;
          if (drop >= 0) this.spawnItem(x + 0.5, y + 0.3, z + 0.5, drop, 1);
        }
      }
      this.exploding = false;
      if (this.effects) this.effects.debris(cx, cy, cz, blocks);
    }
    const blocked = (ox, oy, oz, tx, ty, tz) => this._blocked(ox, oy, oz, tx, ty, tz);
    const box = this._box;
    // Mobs.
    if (this.mobs) for (let i = this.mobs.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs.mobs[i];
      if (m.isDying) continue;
      const r = explosionImpactOn(blocked, cx, cy, cz, m.aabb, power);
      if (r.impact <= 0) continue;
      const dmg = explosionMobDamage(r.impact, power);
      m.invulnTimer = 0;
      m.velocity.x += r.dirX * EXPLOSION_KNOCKBACK * r.impact; m.velocity.z += r.dirZ * EXPLOSION_KNOCKBACK * r.impact; m.velocity.y += (Math.max(r.dirY, 0.3)) * EXPLOSION_KNOCKBACK * r.impact * 0.6;
      this.mobs.hit(m, dmg, cx, cz, false, false);
    }
    // Players: the local one and, when hosting, the guests (through hurtPlayer: the host knows their boxes and armor).
    const p = this.player;
    if (!p.isSpectator) {
      const b = p.aabb;
      const r = explosionImpactOn(blocked, cx, cy, cz, b, power);
      if (r.impact > 0 && this.hurtPlayer) this.hurtPlayer(null, { id: 'self', impact: r.impact, power, kx: r.dirX, ky: Math.max(r.dirY, 0.3), kz: r.dirZ, kind: 'explosion' });
    }
    if (this.remotePlayers) for (const rp of this.remotePlayers.players.values()) {
      if (!rp.state || rp.dead || rp.state.spectator || !rp.interp || !rp.interp.hasData) continue;
      const q = rp.position, hw = PLAYER_WIDTH / 2;
      box.minX = q.x - hw; box.maxX = q.x + hw; box.minY = q.y; box.maxY = q.y + PLAYER_HEIGHT; box.minZ = q.z - hw; box.maxZ = q.z + hw;
      const r = explosionImpactOn(blocked, cx, cy, cz, box, power);
      if (r.impact > 0 && this.hurtPlayer) this.hurtPlayer(null, { id: rp.id, impact: r.impact, power, kx: r.dirX, ky: Math.max(r.dirY, 0.3), kz: r.dirZ, kind: 'explosion' });
    }
    // Other primed explosives fly off; dropped items in the blast are pushed a little too.
    for (const o of this.explosives) {
      if (o === e) continue;
      const r = explosionImpactOn(blocked, cx, cy, cz, o.updateAABB(), power);
      if (r.impact > 0) o.push(r.dirX, r.dirY, r.dirZ, r.impact);
    }
    if (this.effects) this.effects.explosion(cx, cy, cz, power);
    if (this.onExplosion && !this.remote) this.onExplosion(e, cx, cy, cz, power);
  }

  fixedUpdate(dt) {
    const items = this.items;
    const p = this.player;
    this._updateArrows(dt);
    this._updateExplosives(dt);
    // Pickup volume: the player's hitbox grown by 1 block horizontally and 0.5 vertically (Minecraft).
    const box = p.aabb;
    const minX = box.minX - ITEM_PICKUP_EXPAND_XZ, maxX = box.maxX + ITEM_PICKUP_EXPAND_XZ;
    const minY = box.minY - ITEM_PICKUP_EXPAND_Y, maxY = box.maxY + ITEM_PICKUP_EXPAND_Y;
    const minZ = box.minZ - ITEM_PICKUP_EXPAND_XZ, maxZ = box.maxZ + ITEM_PICKUP_EXPAND_XZ;
    const canPickUp = !p.isSpectator;
    if (this.mobs) this.mobs.fixedUpdate(dt, p);
    const simFar = this.simDistanceBlocks;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (simFar !== Infinity && !it.dead && Math.hypot(it.position.x - p.position.x, it.position.z - p.position.z) > simFar) continue; // outside the simulation distance: frozen
      it.fixedUpdate(dt);
      if (it.requestTimer > 0) it.requestTimer -= dt;
      if (it.dead) { if (it.burned && this.onBurn) { it.burned = false; this.onBurn(it.position.x, it.position.y, it.position.z); } continue; }
      // Merge with nearby identical items (the host decides; guests only mirror).
      if (!this.remote) for (let j = i + 1; j < items.length; j++) {
        const o = items[j];
        if (o.dead || o.itemId !== it.itemId) continue;
        if (it.position.distanceToSquared(o.position) < MERGE_RANGE * MERGE_RANGE && it.count + o.count <= 64) {
          it.count += o.count;
          it.pickupDelay = Math.max(it.pickupDelay, o.pickupDelay);
          o.dead = true;
        }
      }
      // Pickup: the item's box touches the grown hitbox (no pull toward the player; spectators never pick up).
      if (it.pickupDelay <= 0 && canPickUp) {
        const ip = it.position;
        const touching = ip.x + ITEM_HALF > minX && ip.x - ITEM_HALF < maxX
          && ip.y + ITEM_HALF > minY && ip.y - ITEM_HALF < maxY
          && ip.z + ITEM_HALF > minZ && ip.z - ITEM_HALF < maxZ;
        if (touching && this.remote && it.id !== null) {
          // A guest asks the host, which grants the item to exactly one player (item:pickupRequest → GuestClient).
          if (it.requestTimer <= 0 && this.inventory.canAccept(it.itemId, it.count) > 0) { it.requestTimer = 0.5; this.events.emit('item:pickupRequest', it); }
        } else if (touching) {
          const left = this.inventory.addItem(it.itemId, it.count);
          if (left < it.count) {
            this.events.emit('item:pickup', it.itemId, it.count - left);
            it.count = left;
            if (left === 0) it.dead = true;
            else it.pickupDelay = 1.0;
          } else {
            it.pickupDelay = 1.0;
          }
        }
      }
    }
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].dead) { const it = items[i]; items.splice(i, 1); this._dropped(it); }
    }
  }

  render(alpha, dt, frustum = null) {
    this.time += dt;
    for (const a of this.arrows) a.render(alpha, this.lightAt ? this.lightAt(a.position.x, a.position.y, a.position.z) : 1);
    for (const e of this.explosives) e.render(alpha, this.time);
    const far = this.entityDistanceBlocks, p = this.player.position;
    for (const it of this.items) {
      const show = far === Infinity || Math.hypot(it.position.x - p.x, it.position.z - p.z) <= far;
      if (show !== it.group.visible) { it.group.visible = show; if (show) this.scene.add(it.group); else this.scene.remove(it.group); } // out of range: out of the scene
      if (it.group.visible) it.render(alpha, this.time, this.lightAt ? this.lightAt(it.position.x, it.position.y + 0.2, it.position.z) : 1);
    }
    if (this.mobs) this.mobs.render(alpha, dt, frustum);
  }

  serialize() {
    return this.items.map((it) => ({ id: it.itemId, n: it.count, x: it.position.x, y: it.position.y, z: it.position.z }));
  }

  deserialize(list) {
    // Items only: the mobs were restored before the chunks streamed in (WorldSession.start) and a full clear here used to
    // wipe them — and the stowed mobs waiting for their chunk — so every loaded world lost its mobs. Arrows and primed
    // explosives are never saved, so they start empty too.
    this.clearItems();
    this.clearProjectiles();
    if (!Array.isArray(list)) return;
    for (const d of list) {
      if (!d || !ItemRegistry.has(d.id) || !(d.n > 0)) continue; // items removed from the game vanish silently
      this.spawnItem(d.x, d.y, d.z, d.id, d.n, 0, 0, 0, ITEM_PICKUP_DELAY);
    }
  }
}
