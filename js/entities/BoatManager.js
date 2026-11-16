// BoatManager.js — the boats of a world (Nov 15 2026, part 2 of 2): placing (on water or on top of a block, in free space),
// seats (two: the first rider drives, a second rides behind; a driver who leaves hands the front seat to the passenger),
// breaking an empty boat (the item drops), targeting (a ray against the hulls), saving (position, heading and velocity next
// to the dropped items and mobs; a rider loads standing), and the host / guest roles of multiplayer: the host owns the list
// and the seats (hooks broadcast BOAT_SPAWN / BOAT_REMOVE / BOAT_RIDERS), the driver's own machine simulates its boat and
// everyone else mirrors it through the Interpolator; an empty boat is the host's to simulate. Boats in chunks that are not
// loaded stay in the list and stand still.

import * as THREE from 'three';
import { Boat, BOAT_WIDTH, BOAT_HEIGHT } from './Boat.js';
import { intersectsSolid, hasSupport } from './EntityPhysics.js';
import { isWater } from '../world/WaterLevels.js';
import { rayBox } from '../utils/RayBox.js';
import { AABB } from '../utils/AABB.js';
import { PLAYER_WIDTH, PLAYER_HEIGHT } from '../config/Constants.js';
import { SOLID } from '../blocks/BlockRegistry.js';

/** How far a player may be from a boat to get in or break it (the host checks the same). */
export const BOAT_REACH = 6;
/** Getting out: the free spots tried around the hull, this far from its centre. */
const EXIT_RING = [1.3, 2.0];

export class BoatManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/World.js').World} world
   * @param {Map<string, THREE.Texture>|null} textures the entity sheets
   * @param {import('../player/Player.js').Player} player the local player (its `riding` / `seat`)
   */
  constructor(scene, world, textures, player) {
    this.scene = scene;
    this.world = world;
    this.textures = textures;
    this.player = player;
    /** @type {Boat[]} */
    this.list = [];
    /** @type {Map<number, Boat>} */
    this.byId = new Map();
    this.nextId = 1;
    /** A guest: the host owns the list and the seats; boats are mirrored unless this player drives them. */
    this.remote = false;
    /** The local player's rider id: 'self' offline, the account's user id while hosting or joined. */
    this.localId = 'self';
    /** Host hooks (HostServer): a boat appeared / went / changed riders. */
    this.onSpawn = null; this.onRemove = null; this.onRiders = null;
    /** Local hooks (Game): the local player got into / out of a boat (seat index or -1). */
    this.onLocalSeat = null;
    /** () => [{ x, z }] of every player: boats far from all of them are not simulated (set by Game). */
    this.playerPositions = null;
    this.simDistanceBlocks = Infinity;
    this.entityDistanceBlocks = Infinity;
    this._tmp = new THREE.Vector3();
    this._box = new AABB();
    this._hit = { boat: null, distance: 0 };
  }

  // ---- the list ----

  /** A new boat (single player / the host); `id` only when restoring a saved or relayed one. */
  spawn(x, y, z, yaw, id = null) {
    if (id === null) id = this.nextId++; else if (id >= this.nextId) this.nextId = id + 1;
    const boat = new Boat(id, x, y, z, yaw, this.textures);
    this.list.push(boat);
    this.byId.set(id, boat);
    this.scene.add(boat.group);
    if (this.onSpawn && !this.remote) this.onSpawn(boat);
    return boat;
  }

  /** A boat the host announced (BOAT_SPAWN / the WELCOME): mirrored unless this player drives it. */
  spawnRemote(row) {
    let boat = this.byId.get(row.id);
    if (!boat) { boat = this.spawn(row.x, row.y, row.z, row.yaw, row.id); } else boat.snapTo(row.x, row.y, row.z, row.yaw);
    if (row.vx !== undefined) boat.velocity.set(+row.vx || 0, +row.vy || 0, +row.vz || 0);
    this.setRiders(boat, row.driver || null, row.passenger || null);
    return boat;
  }

  remove(boat, local = true) {
    if (!boat || boat.dead) return;
    boat.dead = true;
    const i = this.list.indexOf(boat);
    if (i >= 0) this.list.splice(i, 1);
    this.byId.delete(boat.id);
    this.scene.remove(boat.group);
    boat.dispose();
    const wasLocal = boat.driver === this.localId || boat.passenger === this.localId;
    boat.driver = null; boat.passenger = null;
    if (wasLocal) this._localSeat(null, -1);
    if (local && this.onRemove && !this.remote) this.onRemove(boat);
  }

  removeById(id) { const b = this.byId.get(id); if (b) this.remove(b); }

  /** Everything out (leaving a world). */
  clear() {
    for (const b of this.list) { this.scene.remove(b.group); b.dispose(); }
    this.list.length = 0;
    this.byId.clear();
    this.nextId = 1;
    this._localSeat(null, -1);
  }

  // ---- placing and breaking ----

  /** May a boat stand at (x, y, z)? The hull's box must be free of solid blocks and in a loaded chunk. */
  canPlaceAt(x, y, z) {
    if (!this.world.isLoadedAt(x, z) || y < 1 || y > 250) return false;
    const hw = BOAT_WIDTH / 2;
    this._box.set(x - hw, y + 0.02, z - hw, x + hw, y + BOAT_HEIGHT - 0.02, z + hw);
    return !intersectsSolid(this.world, this._box);
  }

  /** The ray against every hull (the local player's own boat skipped, so a rider can mine and place past it). */
  raycast(ox, oy, oz, dx, dy, dz, maxDistance) {
    let best = null, bestT = maxDistance;
    for (const b of this.list) {
      if (b === this.player.riding) continue;
      const a = b.aabb;
      const t = rayBox(ox, oy, oz, dx, dy, dz, a.minX, a.minY, a.minZ, a.maxX, a.maxY, a.maxZ, bestT);
      if (t >= 0 && t < bestT) { bestT = t; best = b; }
    }
    if (!best) return null;
    this._hit.boat = best; this._hit.distance = bestT;
    return this._hit;
  }

  // ---- seats ----

  /** The boat and seat a rider id sits in, or null. */
  seatOf(riderId) {
    for (const b of this.list) { if (b.driver === riderId) return { boat: b, index: 0 }; if (b.passenger === riderId) return { boat: b, index: 1 }; }
    return null;
  }

  /** Who the local player is on the wire. */
  isLocal(id) { return id !== null && id === this.localId; }

  /** The host's (or single player's) authoritative seating: the first rider drives; returns the seat index or -1 when full / already in. */
  assign(boat, riderId) {
    if (!boat || boat.dead) return -1;
    if (boat.driver === riderId) return 0;
    if (boat.passenger === riderId) return 1;
    const prev = this.seatOf(riderId);
    if (prev) this.clearRider(riderId, false); // never in two boats
    let seat = -1;
    if (boat.driver === null) { boat.driver = riderId; seat = 0; }
    else if (boat.passenger === null) { boat.passenger = riderId; seat = 1; }
    if (seat < 0) return -1;
    this._afterRiders(boat);
    return seat;
  }

  /** A rider leaves whatever boat it sits in; a passenger left alone becomes the driver. Returns the boat, or null. */
  clearRider(riderId, announce = true) {
    const s = this.seatOf(riderId);
    if (!s) return null;
    const b = s.boat;
    if (s.index === 0) { b.driver = b.passenger; b.passenger = null; } else b.passenger = null;
    b.input.forward = 0; b.input.turn = 0;
    if (announce) this._afterRiders(b);
    return b;
  }

  /** The host's word on who sits where (BOAT_RIDERS, the WELCOME): applied as is. */
  setRiders(boat, driver, passenger) {
    boat.driver = driver || null;
    boat.passenger = passenger || null;
    this._afterRiders(boat, false);
  }

  _afterRiders(boat, announce = true) {
    // Authority: a boat the local player drives is simulated here (steering never waits for the network); on a guest every
    // other boat is mirrored; on the host a guest-driven boat is mirrored from the relayed state and an empty one is its own.
    const localDrives = boat.driver === this.localId;
    boat.remote = this.remote ? !localDrives : boat.driver !== null && !localDrives;
    if (!boat.remote) { boat.interp.reset(); boat.lastState = null; }
    const seat = boat.driver === this.localId ? 0 : boat.passenger === this.localId ? 1 : -1;
    const riding = this.player.riding;
    if (seat >= 0) this._localSeat(boat, seat);
    else if (riding === boat) this._localSeat(null, -1);
    if (announce && this.onRiders && !this.remote) this.onRiders(boat);
  }

  _localSeat(boat, seat) {
    const p = this.player;
    const was = p.riding;
    p.riding = boat; p.seat = seat < 0 ? 0 : seat;
    if ((was || null) !== (boat || null) || seat >= 0) { if (this.onLocalSeat) this.onLocalSeat(boat, seat); }
  }

  /** The boat the local player drives right now (its state goes out with the player snapshot), or null. */
  drivenByLocal() { const b = this.player.riding; return b && b.driver === this.localId && !b.remote ? b : null; }

  /**
   * Where a rider is put when it gets out: the nearest free spot beside the hull — on solid ground (a solid block under the
   * player's centre) when there is some within about 2 blocks, otherwise in the water next to the boat, otherwise a spot the
   * box's edge rests on; the boat's own position as a last resort.
   */
  exitSpot(boat, out) {
    const world = this.world, p = boat.position;
    let bestLand = null, bestWater = null, bestEdge = null, dLand = Infinity, dWater = Infinity, dEdge = Infinity;
    const box = this._box;
    for (const r of EXIT_RING) {
      for (let k = 0; k < 8; k++) {
        const a = boat.yaw + Math.PI / 2 + k * Math.PI / 4; // the sides first
        const x = p.x - Math.sin(a) * r, z = p.z - Math.cos(a) * r;
        if (!world.isLoadedAt(x, z)) continue;
        for (let y = Math.floor(p.y) + 1; y >= Math.floor(p.y) - 2; y--) {
          box.setFromFeet(x, y, z, PLAYER_WIDTH, PLAYER_HEIGHT);
          if (intersectsSolid(world, box)) continue;
          const d = Math.hypot(x - p.x, z - p.z) + Math.abs(y - p.y) * 0.5;
          const bx = Math.floor(x), bz = Math.floor(z);
          if (hasSupport(world, box)) {
            if (SOLID[world.getBlock(bx, y - 1, bz)] === 1) { if (d < dLand) { dLand = d; bestLand = [x, y, z]; } } // standing on the block, not on its edge
            else if (d < dEdge) { dEdge = d; bestEdge = [x, y, z]; }
          } else if (isWater(world.getBlock(bx, y, bz)) || isWater(world.getBlock(bx, y - 1, bz))) { if (d < dWater) { dWater = d; bestWater = [x, y, z]; } }
          break; // the highest free cell of this column is the one to stand in
        }
      }
    }
    const spot = bestLand || bestWater || bestEdge || [p.x, p.y + BOAT_HEIGHT, p.z];
    return out.set(spot[0], spot[1], spot[2]);
  }

  // ---- simulation and drawing ----

  /** Every locally simulated boat steps (not the mirrored ones, not the ones far from every player or in unloaded chunks). */
  fixedUpdate(dt) {
    if (!this.list.length) return;
    const players = this.playerPositions ? this.playerPositions() : [{ x: this.player.position.x, z: this.player.position.z }];
    const far = this.simDistanceBlocks;
    for (const b of this.list) {
      if (b.remote) continue;
      if (far !== Infinity) {
        let near = false;
        for (const q of players) if (Math.hypot(b.position.x - q.x, b.position.z - q.z) <= far) { near = true; break; }
        if (!near) continue;
      }
      if (b.driver === null && b.passenger === null) { b.input.forward = 0; b.input.turn = 0; }
      b.fixedUpdate(dt, this.world);
    }
  }

  render(alpha, lightAt = null) {
    if (!this.list.length) return;
    const now = performance.now() / 1000;
    const far = this.entityDistanceBlocks, p = this.player.position;
    for (const b of this.list) {
      const show = far === Infinity || Math.hypot(b.position.x - p.x, b.position.z - p.z) <= far;
      if (show !== b.group.visible) b.group.visible = show;
      b.render(alpha, now, show && lightAt ? lightAt(b.position.x, b.position.y + 0.3, b.position.z) : 1);
    }
  }

  // ---- saving ----

  serialize() { return this.list.map((b) => b.serialize()); }

  /** Loading a world: the saved boats, empty (a rider loads standing where it sat). */
  deserialize(list) {
    this.clear();
    if (!Array.isArray(list)) return;
    for (const d of list) {
      if (!d || ![d.x, d.y, d.z].every(Number.isFinite)) continue;
      const b = this.spawn(d.x, d.y, d.z, +d.yaw || 0, Number.isInteger(d.id) && d.id > 0 ? d.id : null);
      b.velocity.set(+d.vx || 0, +d.vy || 0, +d.vz || 0);
    }
  }

  /** A joining guest: the host's boats and their riders. */
  deserializeRemote(list) {
    this.clear();
    for (const row of list || []) this.spawnRemote(row);
  }

  /** The wire row of a boat (BOAT_SPAWN, the WELCOME). */
  row(boat) {
    const p = boat.position, v = boat.velocity;
    return { id: boat.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), yaw: +boat.yaw.toFixed(4), vx: +v.x.toFixed(3), vy: +v.y.toFixed(3), vz: +v.z.toFixed(3), driver: boat.driver, passenger: boat.passenger };
  }
}
