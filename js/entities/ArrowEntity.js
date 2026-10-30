// ArrowEntity.js — an arrow in flight or stuck in a block. Minecraft-like physics at the 60 Hz step: gravity 20 blocks/s²,
// drag 0.99 per 20 Hz tick, and every step's movement is swept against blocks (voxel DDA) and the entity boxes the owner
// hands in (mobs, other players, the local player), so a fast arrow never passes through anything. A hit on a block
// sticks the arrow where it landed for ARROW_STUCK_SECONDS (the shooter picks it up in Survival); a hit on a mob or a
// player removes it. The model is Minecraft's: two crossed planes along the shaft (the sheet's 16×5 strip, rows 0–4 of
// textures/entity/arrow.png) and a square back cap at the nock end carrying the fletching seen from behind (the 5×5 at
// rows 5–9), about 0.8 blocks long and 0.25 tall, rotated along the flight. The material is unlit (MeshBasicMaterial,
// alpha-tested, double-sided) and tinted by the light at the arrow like the dropped items, so thin planes never go dark
// from their normals. Pure physics apart from the Three.js mesh; the damage is applied by EntityManager through callbacks.

import * as THREE from 'three';
import { ARROW_GRAVITY, ARROW_DRAG_PER_TICK, ARROW_STUCK_SECONDS, ARROW_FLIGHT_SECONDS, VOID_Y } from '../config/Constants.js';
import { sameLight, copyLight, applyLight } from '../rendering/LightUniforms.js';
import { isWater } from '../world/WaterLevels.js';

/** Drag per 20 Hz tick while the arrow moves through water. */
const ARROW_WATER_DRAG_PER_TICK = 0.6;

export const ARROW_LENGTH = 0.8, ARROW_HEIGHT = 0.25;
let sharedGeometry = null;
/**
 * The crossed planes along +X (the arrow points toward +X in model space) sampling the strip (rows 0–4) and the back cap
 * at −X in the YZ plane sampling the 5×5 at rows 5–9, columns 0–4. One winding per quad: the material is double-sided.
 */
export function arrowGeometry() {
  if (sharedGeometry) return sharedGeometry;
  const g = new THREE.BufferGeometry();
  const h = ARROW_HEIGHT / 2, l = ARROW_LENGTH / 2;
  const vStrip = 1 - 5 / 16;                       // rows 0–4 of a 16-row sheet (flipY: v = 1 − row / 16)
  const uCap = 5 / 16, vCapTop = 1 - 5 / 16, vCapBottom = 1 - 10 / 16; // rows 5–9, columns 0–4
  const pos = [
    -l, -h, 0, l, -h, 0, l, h, 0, -l, h, 0,       // vertical plane
    -l, 0, -h, l, 0, -h, l, 0, h, -l, 0, h,       // horizontal plane
    -l, -h, -h, -l, -h, h, -l, h, h, -l, h, -h,   // the back cap (nock end), facing −X
  ];
  const uv = [
    0, vStrip, 1, vStrip, 1, 1, 0, 1,
    0, vStrip, 1, vStrip, 1, 1, 0, 1,
    0, vCapBottom, uCap, vCapBottom, uCap, vCapTop, 0, vCapTop,
  ];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  sharedGeometry = g;
  return g;
}

export class ArrowEntity {
  /**
   * @param {THREE.Material} material this arrow's own unlit, alpha-tested material over the arrow sheet (tinted per arrow)
   * @param {object} o { x, y, z, vx, vy, vz, shooter ('self' | user id | null), power, crit, pickup, id, remote }
   */
  constructor(material, o) {
    this.position = new THREE.Vector3(o.x, o.y, o.z);
    this.prevPosition = this.position.clone();
    this.velocity = new THREE.Vector3(o.vx, o.vy, o.vz);
    this.shooter = o.shooter ?? null;
    this.power = o.power ?? 1;
    this.crit = !!o.crit;
    /** Survival arrows can be picked up by their shooter once stuck; Creative arrows cannot. */
    this.pickup = o.pickup !== false;
    this.id = o.id ?? null;
    /** Guests mirror the host's arrow: the same physics locally, no damage, corrections from the host. */
    this.remote = !!o.remote;
    this.stuck = false;
    /** The block a stuck arrow sits in; when it disappears the arrow comes loose and falls (set by land()). */
    this.stuckBlock = null;
    /** Set by the owner: the world, for the stuck-block check and the water drag. */
    this.world = null;
    /** True once an arrow came loose from a vanished block (it flies and falls like a shot one, keeping its pickup rules). */
    this.loose = false;
    this.age = 0;
    this.stuckTime = 0;
    this.dead = false;
    this.mesh = new THREE.Mesh(arrowGeometry(), material);
    this.mesh.frustumCulled = true;
    this.mesh.userData.noShadow = true;
    this._dir = new THREE.Vector3();
    this._light = null;
    this._orient();
  }

  /** The arrow points along its velocity (while stuck, along the direction it hit with). */
  _orient() {
    const v = this.velocity;
    if (v.lengthSq() < 1e-6) return;
    this._dir.copy(v).normalize();
    const yaw = Math.atan2(-this._dir.z, this._dir.x); // model +X → flight direction
    const pitch = Math.asin(Math.max(-1, Math.min(1, this._dir.y)));
    this.mesh.rotation.set(0, yaw, pitch, 'YZX');
  }

  /**
   * One physics step. `sweep(ox, oy, oz, dx, dy, dz, len)` → { t, kind: 'block' | 'mob' | 'player', target } or null, the
   * nearest thing along the movement segment (t in blocks); the owner decides what each hit means and calls `land()`
   * or removes the arrow.
   */
  fixedUpdate(dt, sweep) {
    this.age += dt;
    this.prevPosition.copy(this.position);
    if (this.stuck) {
      this.stuckTime += dt;
      if (this.stuckTime >= ARROW_STUCK_SECONDS) { this.dead = true; return null; }
      // The block it sits in is gone (broken, exploded, replaced by air or a liquid): the arrow comes loose and falls.
      const b = this.stuckBlock;
      if (b && this.world && !this.world.isSolid(b.x, b.y, b.z)) this.unstick();
      else return null;
    }
    if ((!this.loose && this.age > ARROW_FLIGHT_SECONDS) || this.position.y < VOID_Y) { this.dead = true; return null; }
    const v = this.velocity;
    v.y -= ARROW_GRAVITY * dt;
    const inWater = this.world && isWater(this.world.getBlock(Math.floor(this.position.x), Math.floor(this.position.y), Math.floor(this.position.z)));
    const drag = Math.pow(inWater ? ARROW_WATER_DRAG_PER_TICK : ARROW_DRAG_PER_TICK, dt * 20);
    v.multiplyScalar(drag);
    const len = v.length() * dt;
    if (len <= 0) return null;
    const dx = v.x / v.length(), dy = v.y / v.length(), dz = v.z / v.length();
    const hit = sweep ? sweep(this.position.x, this.position.y, this.position.z, dx, dy, dz, len) : null;
    if (hit && hit.t <= len) {
      this.position.addScaledVector(this._dir.set(dx, dy, dz), Math.max(0, hit.t - 0.02));
      this._orient();
      return hit;
    }
    this.position.addScaledVector(this._dir.set(dx, dy, dz), len);
    this._orient();
    return null;
  }

  /** Stick where it is (a block hit): no more movement; the tip stays a little inside the face it hit. `block` is the cell hit. */
  land(block = null) {
    this.stuck = true;
    this.stuckTime = 0;
    this.stuckBlock = block;
    this.velocity.multiplyScalar(0.001);
  }

  /** Come loose (the block vanished, or a blast shook it out): it falls from rest and sticks again where it lands. */
  unstick() {
    this.stuck = false;
    this.stuckBlock = null;
    this.loose = true;
    this.stuckTime = 0;
    this.velocity.set(0, 0, 0);
  }

  /** An explosion's push (outward direction × impact): loose and flying arrows fly off; a stuck one comes loose when the push is strong. */
  push(dx, dy, dz, impact) {
    if (this.stuck) { if (impact <= 0.3) return; this.unstick(); }
    const k = 12 * impact;
    this.velocity.x += dx * k; this.velocity.y += Math.max(dy, 0.25) * k; this.velocity.z += dz * k;
    this._orient();
  }

  /** Visual update: interpolated position and the tint of the light where the arrow is (a factor or an [r, g, b]). */
  render(alpha, light = 1) {
    this.mesh.position.lerpVectors(this.prevPosition, this.position, alpha);
    if (!sameLight(light, this._light)) { this._light = copyLight(light, this._light); applyLight(this.mesh.material.color, light); }
  }

  dispose() { this.mesh.material.dispose(); }
}
