// EntityManager.js — owns item entities: spawning, physics ticks, pickup, merging, rendering. In multiplayer
// (Update #8) every item has an id; the host spawns / removes items and tells everyone (onSpawn / onRemove
// hooks), while a guest (`remote`) mirrors them, asks the host to pick up items (item:pickupRequest) and
// throws through the host (throwHook).

import { ItemRegistry } from '../items/ItemRegistry.js';
import * as THREE from 'three';
import { ItemEntity } from './ItemEntity.js';
import { createBlockModelMaterial, createBlockModelMaterialTranslucent } from '../rendering/Materials.js';
import { PASS, RenderPass } from '../blocks/BlockRegistry.js';
import { ITEM_PICKUP_DELAY, ITEM_THROW_PICKUP_DELAY, ITEM_PICKUP_EXPAND_XZ, ITEM_PICKUP_EXPAND_Y } from '../config/Constants.js';
import { ITEM_HALF } from './ItemEntity.js';

const MERGE_RANGE = 0.75;

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
    /** Update #9 §7: items farther than this do not update (simulation distance) / are hidden (entity distance). */
    this.simDistanceBlocks = Infinity;
    this.entityDistanceBlocks = Infinity;
    /** (x, y, z) → brightness factor of the sky light there (Update #10), set by Game. */
    this.lightAt = null;
    /** (x, y, z) an item burned in lava (Update #11): Game plays the sizzle. */
    this.onBurn = null;
    /** Host hooks (set by HostServer): broadcast spawns and removals. */
    this.onSpawn = null;
    this.onRemove = null;
    /** Guest hook: throwing goes through the host instead of spawning locally. */
    this.throwHook = null;
  }

  clear() {
    for (const it of this.items) { this.scene.remove(it.group); it.mesh.material.dispose(); }
    this.items.length = 0;
    this.byId.clear();
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

  fixedUpdate(dt) {
    const items = this.items;
    const p = this.player;
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

  render(alpha, dt) {
    this.time += dt;
    const far = this.entityDistanceBlocks, p = this.player.position;
    for (const it of this.items) {
      it.group.visible = far === Infinity || Math.hypot(it.position.x - p.x, it.position.z - p.z) <= far;
      if (it.group.visible) it.render(alpha, this.time, this.lightAt ? this.lightAt(it.position.x, it.position.y + 0.2, it.position.z) : 1);
    }
    if (this.mobs) this.mobs.render(alpha, dt);
  }

  serialize() {
    return this.items.map((it) => ({ id: it.itemId, n: it.count, x: it.position.x, y: it.position.y, z: it.position.z }));
  }

  deserialize(list) {
    this.clear();
    if (!Array.isArray(list)) return;
    for (const d of list) {
      if (!d || !ItemRegistry.has(d.id) || !(d.n > 0)) continue; // items removed from the game vanish silently
      this.spawnItem(d.x, d.y, d.z, d.id, d.n, 0, 0, 0, ITEM_PICKUP_DELAY);
    }
  }
}
