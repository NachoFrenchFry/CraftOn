// ItemEntity.js — a dropped item: small spinning/bobbing block cube with gravity, ground collision,
// pickup attraction, merging and despawn.

import * as THREE from 'three';
import { createBlockGeometry } from '../rendering/BlockGeometry.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { Direction } from '../utils/Direction.js';
import { sameLight, copyLight, applyLight } from '../rendering/LightUniforms.js';
import { createItemSpriteGeometry } from '../rendering/ItemSpriteGeometry.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { GRAVITY, ITEM_DESPAWN_SECONDS, ITEM_WATER_PUSH, ITEM_BUOYANCY } from '../config/Constants.js';
import { SOLID } from '../blocks/BlockRegistry.js';
import { isWater, isLava } from '../world/WaterLevels.js';

const SIZE = 0.25;
const HALF = SIZE / 2;
/** Half extent of an item entity's box (pickup overlap test). */
export const ITEM_HALF = HALF;

export class ItemEntity {
  /**
   * @param {import('../world/World.js').World} world
   * @param {THREE.Material} material
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} atlas
   */
  constructor(world, material, atlas, itemId, count, x, y, z, vx, vy, vz, pickupDelay) {
    this.world = world;
    /** Set by EntityManager: flowing water pushes items. */
    this.waterSim = null;
    this._flow = { x: 0, y: 0, z: 0 };
    this.itemId = itemId;
    this.count = count;
    this.position = new THREE.Vector3(x, y, z);
    this.prevPosition = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3(vx, vy, vz);
    this.pickupDelay = pickupDelay;
    this.age = 0;
    this.onGround = false;
    this.dead = false;
    /** Lava (Update #11): destroyed by lava (EntityManager sizzles). */
    this.burned = false;
    this.spinOffset = Math.random() * Math.PI * 2;
    this.group = new THREE.Group();
    const item = ItemRegistry.get(itemId);
    const spriteTexture = item && (!item.isBlock ? item.texture : BlockRegistry.isTorch(itemId) ? BlockRegistry.faceTexture(itemId, Direction.SOUTH) : null); // torches drop as their sprite (Update #11)
    const geom = spriteTexture ? createItemSpriteGeometry(atlas, spriteTexture, SIZE * 1.6) : createBlockGeometry(itemId, SIZE);
    this.mesh = new THREE.Mesh(geom, material);
    this.group.add(this.mesh);
    this.group.position.copy(this.position);
  }

  _solidAt(x, y, z) { return SOLID[this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1; }

  fixedUpdate(dt) {
    this.age += dt;
    if (this.pickupDelay > 0) this.pickupDelay -= dt;
    if (this.age > ITEM_DESPAWN_SECONDS) { this.dead = true; return; }
    const p = this.position, v = this.velocity;
    this.prevPosition.copy(p);
    if (!this.world.isLoadedAt(p.x, p.z)) return;
    const here = this.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (isLava(here) || isLava(this.world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.15), Math.floor(p.z)))) { this.dead = true; this.burned = true; return; }
    const inWater = isWater(here);
    if (inWater) {
      // Float up gently and drift with the current.
      v.y += ITEM_BUOYANCY * dt;
      if (v.y > 1.2) v.y = 1.2;
      if (this.waterSim) {
        const f = this.waterSim.flowVector(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), this._flow);
        v.x += f.x * ITEM_WATER_PUSH * dt; v.z += f.z * ITEM_WATER_PUSH * dt; v.y += f.y * ITEM_WATER_PUSH * 0.5 * dt;
      }
      const drag = Math.exp(-3 * dt);
      v.x *= drag; v.z *= drag;
    } else {
      v.y -= GRAVITY * 0.5 * dt;
    }
    if (v.y < -20) v.y = -20;
    // Y
    let ny = p.y + v.y * dt;
    if (v.y < 0 && this._solidAt(p.x, ny - HALF, p.z)) {
      ny = Math.floor(ny - HALF) + 1 + HALF;
      v.y = 0;
      this.onGround = true;
    } else if (v.y > 0 && this._solidAt(p.x, ny + HALF, p.z)) {
      v.y = 0;
    } else {
      this.onGround = false;
    }
    p.y = ny;
    // X / Z
    const nx = p.x + v.x * dt;
    if (!this._solidAt(nx + Math.sign(v.x) * HALF, p.y, p.z)) p.x = nx; else v.x = 0;
    const nz = p.z + v.z * dt;
    if (!this._solidAt(p.x, p.y, nz + Math.sign(v.z) * HALF)) p.z = nz; else v.z = 0;
    const friction = this.onGround ? Math.exp(-8 * dt) : Math.exp(-0.5 * dt);
    v.x *= friction; v.z *= friction;
    // Stuck inside a block (block placed on it): pop upward.
    if (this._solidAt(p.x, p.y, p.z)) { p.y = Math.floor(p.y) + 1 + HALF; v.y = 2; }
  }

  /** Visual update: interpolate, spin and bob. */
  render(alpha, time, light = 1) {
    if (!sameLight(light, this._light)) { this._light = copyLight(light, this._light); applyLight(this.mesh.material.color, light); } // own clone (EntityManager), lit by the sky + block light at the item
    const g = this.group;
    g.position.lerpVectors(this.prevPosition, this.position, alpha);
    g.position.y += Math.sin(time * 2 + this.spinOffset) * 0.05 + 0.05;
    this.mesh.rotation.y = time * 1.5 + this.spinOffset;
  }
}
