// Boat.js — one boat (Nov 15 2026, part 2 of 2): a 1.375 × 0.5625 × 1.375 hull of five textured boxes (a floor and four low
// sides over textures/entity/boat.png, planks colours, no paddles) with two seats — the front seat drives, the back one rides.
// A boat is either simulated here (single player; the host for empty boats; the driver's own machine, so steering never waits
// for the network) with BoatPhysics.js for the heading and the horizontal speed, gravity or buoyancy for the vertical, and
// the shared box sweep for blocks — or mirrored (`remote`) through the Interpolator from the states the host relays. It
// floats with its floor a little under the water surface and rises with the water, never sinks, treats lava like air (it
// sinks and the riders burn), stops at the edge of the loaded chunks, loses the speed of a blocked axis, never climbs a
// step, never pushes anything and is never hurt by a fall.

import * as THREE from 'three';
import { GRAVITY, TERMINAL_VELOCITY, MOB_PX } from '../config/Constants.js';
import { SOLID, SLIPPERY } from '../blocks/BlockRegistry.js';
import { isWater, heightOf } from '../world/WaterLevels.js';
import { moveBox, hasSupport } from './EntityPhysics.js';
import { createMobModel } from './mobs/MobModel.js';
import { Interpolator } from '../net/Interpolator.js';
import { AABB } from '../utils/AABB.js';
import { applyLight, sameLight, copyLight } from '../rendering/LightUniforms.js';
import { angleDelta } from '../utils/MathUtils.js';
import { boatStep, BOAT_WIDTH, BOAT_HEIGHT } from './BoatPhysics.js';

export { BOAT_WIDTH, BOAT_HEIGHT };
/** The floor sits this far under the water surface when the boat floats. */
export const BOAT_DRAFT = 0.15;
/** Seats: the rider's feet, in boat space (z negative = forward); a rider's hips then sit at the gunwale. */
export const BOAT_SEATS = Object.freeze([{ x: 0, y: -0.15, z: -0.3 }, { x: 0, y: -0.15, z: 0.45 }]);

/** The hull: box nets on a 128×64 sheet (MobModel.createMobModel; sizes and offsets in sixteenths, the model faces −Z). */
export const BOAT_MODEL = Object.freeze({
  type: 'boat', texture: 'boat', sheet: [128, 64],
  parts: [
    { name: 'floor', size: [22, 2, 22], uv: [0, 0], pivot: [0, 1, 0], offset: [0, 0, 0] },
    { name: 'left', size: [2, 7, 22], uv: [0, 24], pivot: [-10, 5.5, 0], offset: [0, 0, 0] },
    { name: 'right', size: [2, 7, 22], uv: [0, 24], pivot: [10, 5.5, 0], offset: [0, 0, 0] },
    { name: 'front', size: [18, 7, 2], uv: [48, 24], pivot: [0, 5.5, -10], offset: [0, 0, 0] },
    { name: 'back', size: [18, 7, 2], uv: [48, 24], pivot: [0, 5.5, 10], offset: [0, 0, 0] },
  ],
});

export class Boat {
  /**
   * @param {number|null} id entity id (null until the host / single player assigns one)
   * @param {Map<string, THREE.Texture>|null} textures the entity sheets ('boat')
   */
  constructor(id, x, y, z, yaw, textures) {
    this.id = id;
    this.position = new THREE.Vector3(x, y, z);
    this.prevPosition = new THREE.Vector3(x, y, z);
    this.renderPosition = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3();
    this.yaw = yaw || 0;
    this.prevYaw = this.yaw;
    this.renderYaw = this.yaw;
    this.turnRate = 0;
    /** Rider ids ('self' offline, user ids online), or null. The front seat drives. */
    this.driver = null;
    this.passenger = null;
    /** Mirrored from the network (the Interpolator) instead of simulated here. */
    this.remote = false;
    this.interp = new Interpolator();
    /** The host's copy of the latest state array a driving guest sent (relayed to the others as is). */
    this.lastState = null;
    /** The driver's input this step: forward −1..1, turn −1..1 (+1 = left). */
    this.input = { forward: 0, turn: 0 };
    this.onGround = false;
    this.inWater = false;
    this.surface = 'air';
    this.dead = false;
    this.aabb = new AABB();
    this.updateAABB();
    const built = createMobModel(BOAT_MODEL, textures || new Map());
    this.group = built.root;
    this.materials = built.materials;
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
    this._light = null;
    this._state = { yaw: this.yaw, turnRate: 0, vx: 0, vz: 0 };
    this._out = { dx: 0, dz: 0 };
    this._move = { movedX: 0, movedY: 0, movedZ: 0, landed: false, hitCeiling: false, blockedX: false, blockedZ: false };
  }

  get empty() { return this.driver === null && this.passenger === null; }
  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  updateAABB() {
    const p = this.position, hw = BOAT_WIDTH / 2;
    this.aabb.set(p.x - hw, p.y, p.z - hw, p.x + hw, p.y + BOAT_HEIGHT, p.z + hw);
    return this.aabb;
  }

  /** The seat `index` (0 front, 1 back) as a rider's feet position in the world, from the boat's `position` and `yaw` (or the render pose). */
  seatPosition(index, out, rendered = false) {
    const s = BOAT_SEATS[index] || BOAT_SEATS[0];
    const yaw = rendered ? this.renderYaw : this.yaw, p = rendered ? this.renderPosition : this.position;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // forward
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);    // right
    return out.set(p.x + fx * -s.z + rx * s.x, p.y + s.y, p.z + fz * -s.z + rz * s.x);
  }

  /** The water surface (world y) at the boat's column when its floor is in water, else null: the highest water cell of the column at the floor plus its level. */
  _waterSurface(world) {
    const p = this.position, bx = Math.floor(p.x), bz = Math.floor(p.z);
    let y = Math.floor(p.y + 0.05);
    if (!isWater(world.getBlock(bx, y, bz))) { y = Math.floor(p.y - 0.05); if (!isWater(world.getBlock(bx, y, bz))) return null; }
    while (isWater(world.getBlock(bx, y + 1, bz))) y++;
    return y + heightOf(world.getBlock(bx, y, bz));
  }

  /** The block right under the floor (centre column), or 0 in the air. */
  _blockUnder(world) {
    const p = this.position;
    return world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.01), Math.floor(p.z));
  }

  /** One game step of the local simulation (never for a mirrored boat). */
  fixedUpdate(dt, world) {
    const p = this.position, v = this.velocity;
    this.prevPosition.copy(p);
    this.prevYaw = this.yaw;
    if (!world.isLoadedAt(p.x, p.z)) { v.set(0, 0, 0); this.turnRate = 0; return; } // the edge of the loaded chunks: still
    const surfaceY = this._waterSurface(world);
    this.inWater = surfaceY !== null;
    if (this.inWater) this.surface = 'water';
    else if (this.onGround) this.surface = SLIPPERY[this._blockUnder(world)] === 1 ? 'ice' : 'ground';
    else this.surface = 'air';
    // Heading and horizontal speed (BoatPhysics): the thrust follows the heading, the velocity stays in world space.
    const st = this._state;
    st.yaw = this.yaw; st.turnRate = this.turnRate; st.vx = v.x; st.vz = v.z;
    boatStep(st, this.input, this.surface, dt, this._out);
    this.yaw = st.yaw; this.turnRate = st.turnRate; v.x = st.vx; v.z = st.vz;
    // Vertical: afloat the floor seeks BOAT_DRAFT under the surface (and follows a rising or falling level); otherwise gravity,
    // lava included — the boat sinks through lava like air, and its riders burn as usual.
    if (this.inWater) {
      const d = surfaceY - BOAT_DRAFT - p.y;
      v.y = Math.min(3, Math.max(-2, d * 8));
    } else {
      v.y -= GRAVITY * dt;
      if (v.y < -TERMINAL_VELOCITY) v.y = -TERMINAL_VELOCITY;
    }
    // Never into unloaded terrain: the boat stops at the edge, as the player does.
    let dx = this._out.dx, dz = this._out.dz;
    if (!world.isLoadedAt(p.x + dx, p.z + dz)) { dx = 0; dz = 0; v.x = 0; v.z = 0; }
    // Blocks: the shared sweep (Y, then X, then Z); a blocked axis loses its speed; no step climbing.
    const box = this.updateAABB();
    const m = moveBox(world, box, dx / dt, v.y, dz / dt, dt, this._move);
    if (m.landed || m.hitCeiling) v.y = 0;
    this.onGround = m.landed || (this.onGround && m.movedY === 0 && hasSupport(world, box));
    if (m.blockedX) v.x = 0;
    if (m.blockedZ) v.z = 0;
    p.set((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2);
  }

  /** A state from the network (the host relays the driver's, or sends its own for an empty boat): queued for interpolation. */
  applyRemote(now, row) {
    this.interp.push(now, +row[1], +row[2], +row[3], +row[4] || 0, +row[5] || 0, +row[6] || 0, +row[7] || 0, 0, null);
  }

  /** Snap to a position (a spawn row, a load): no interpolation from wherever the boat was. */
  snapTo(x, y, z, yaw) {
    this.position.set(x, y, z); this.prevPosition.set(x, y, z); this.renderPosition.set(x, y, z);
    this.yaw = this.prevYaw = this.renderYaw = yaw || 0;
    this.velocity.set(0, 0, 0); this.turnRate = 0;
    this.interp.reset();
    this.updateAABB();
    this.group.position.copy(this.position); this.group.rotation.y = this.yaw;
  }

  /** The compact state array shared on the state channel: [id, x, y, z, vx, vy, vz, yaw]. */
  stateRow() {
    const p = this.position, v = this.velocity;
    return [this.id, +p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3), +v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3), +this.yaw.toFixed(4)];
  }

  /** A mirrored boat: the Interpolator's sample at `now` becomes its pose (seats, reach and the hull all use it); idempotent within a frame. */
  sampleRemote(now) {
    if (!this.interp.hasData) return;
    const o = this.interp.sample(now);
    this.renderPosition.set(o.x, o.y, o.z);
    this.renderYaw = o.yaw;
    this.position.copy(this.renderPosition); this.prevPosition.copy(this.renderPosition);
    this.velocity.set(o.vx, o.vy, o.vz);
    this.yaw = this.prevYaw = o.yaw;
    this.updateAABB();
  }

  /** Per frame: the mirrored boat samples the Interpolator, a local one lerps the physics states. */
  render(alpha, now, light = 1) {
    if (this.remote) {
      this.sampleRemote(now);
    } else {
      this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
      this.renderYaw = this.prevYaw + angleDelta(this.yaw, this.prevYaw) * alpha;
    }
    this.group.position.copy(this.renderPosition);
    this.group.rotation.y = this.renderYaw;
    if (!sameLight(light, this._light)) { this._light = copyLight(light, this._light); for (const m of this.materials) applyLight(m.color, light); }
  }

  serialize() {
    const p = this.position, v = this.velocity;
    return { id: this.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), yaw: +this.yaw.toFixed(4), vx: +v.x.toFixed(3), vy: +v.y.toFixed(3), vz: +v.z.toFixed(3) };
  }

  dispose() { for (const m of this.materials) m.dispose(); }
}
