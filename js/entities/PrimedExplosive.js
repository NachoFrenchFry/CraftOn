// PrimedExplosive.js — a placed explosive turned into an entity: a block-sized box with gravity and voxel collisions
// (so it falls, slides off edges and gets pushed by other blasts), flashing white about four times a second and faster
// toward the end of its 4 s fuse, then it explodes (EntityManager runs the blast). Guests mirror the host's entity with
// the same local physics and get the explosion from the host.

import * as THREE from 'three';
import { AABB } from '../utils/AABB.js';
import { moveBox, hasSupport } from './EntityPhysics.js';
import { createBlockGeometry } from '../rendering/BlockGeometry.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { GRAVITY, TERMINAL_VELOCITY, EXPLOSIVE_FUSE_SECONDS } from '../config/Constants.js';

const SIZE = 0.98;
let flashMaterial = null;

export class PrimedExplosive {
  /**
   * @param {THREE.Material} blockMaterial the block model material (atlas)
   * @param {object} o { x, y, z (the block's bottom centre), vx, vy, vz, fuse, id, remote }
   */
  constructor(blockMaterial, o) {
    this.position = new THREE.Vector3(o.x, o.y, o.z);
    this.prevPosition = this.position.clone();
    this.velocity = new THREE.Vector3(o.vx || 0, o.vy || 0, o.vz || 0);
    this.fuse = o.fuse ?? EXPLOSIVE_FUSE_SECONDS;
    this.fuseTotal = this.fuse;
    this.id = o.id ?? null;
    this.remote = !!o.remote;
    this.onGround = false;
    this.dead = false;
    this.exploded = false;
    this.hissed = false;
    this.aabb = new AABB();
    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(createBlockGeometry(BlockIds.EXPLOSIVES, SIZE), blockMaterial);
    this.mesh.position.y = SIZE / 2;
    this.group.add(this.mesh);
    // The white flash: a slightly bigger box that pulses on and off.
    if (!flashMaterial) flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false });
    this.flash = new THREE.Mesh(new THREE.BoxGeometry(SIZE + 0.04, SIZE + 0.04, SIZE + 0.04), flashMaterial);
    this.flash.position.y = SIZE / 2;
    this.flash.visible = false;
    this.flash.userData.noShadow = true;
    this.group.add(this.flash);
    this._move = {};
  }

  /** The box of the block entity (feet at `position`). */
  updateAABB() { return this.aabb.setFromFeet(this.position.x, this.position.y, this.position.z, SIZE, SIZE); }

  /** Push from another blast: velocity along the outward direction, scaled by the impact. */
  push(dx, dy, dz, impact) {
    const k = impact * 10;
    this.velocity.x += dx * k; this.velocity.y += Math.max(dy, 0.25) * k * 0.8 + 2 * impact; this.velocity.z += dz * k;
  }

  /** One physics step; returns true when the fuse ran out (the owner explodes it). */
  fixedUpdate(dt, world) {
    this.prevPosition.copy(this.position);
    this.fuse -= dt;
    if (!world.isLoadedAt(this.position.x, this.position.z)) return this.fuse <= 0;
    const v = this.velocity;
    v.y -= GRAVITY * 0.6 * dt;
    if (v.y < -TERMINAL_VELOCITY) v.y = -TERMINAL_VELOCITY;
    const box = this.updateAABB();
    const m = moveBox(world, box, v.x, v.y, v.z, dt, this._move);
    if (m.landed) v.y = 0;
    if (m.hitCeiling) v.y = 0;
    this.onGround = m.landed || (this.onGround && m.movedY === 0 && hasSupport(world, box));
    if (m.blockedX) v.x = 0;
    if (m.blockedZ) v.z = 0;
    const friction = this.onGround ? Math.exp(-6 * dt) : Math.exp(-0.3 * dt);
    v.x *= friction; v.z *= friction;
    this.position.set((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2);
    return this.fuse <= 0;
  }

  /** Visual update: interpolated position and the quickening flash. */
  render(alpha, time) {
    this.group.position.lerpVectors(this.prevPosition, this.position, alpha);
    const left = Math.max(0, this.fuse), rate = left < 1 ? 10 : left < 2 ? 6 : 4; // flashes per second, faster near the end
    this.flash.visible = Math.sin(time * Math.PI * 2 * rate) > 0;
  }
}
