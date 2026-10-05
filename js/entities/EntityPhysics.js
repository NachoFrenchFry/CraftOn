// EntityPhysics.js — AABB-vs-voxel collision shared by the player and mobs: one-axis sweeps against
// solid blocks, ground support and headroom tests. Pure functions over a world with getBlock().

import { SOLID } from '../blocks/BlockRegistry.js';
import { COLLISION_EPSILON as EPS } from '../config/Constants.js';

export function isSolidAt(world, x, y, z) {
  return SOLID[world.getBlock(x, y, z)] === 1;
}

/** Clamp a movement delta along one axis (0 = x, 1 = y, 2 = z) so the box never enters a solid block. */
export function sweepAxis(world, box, axis, delta) {
  if (delta === 0) return 0;
  const x0 = Math.floor(box.minX + EPS), x1 = Math.floor(box.maxX - EPS);
  const y0 = Math.floor(box.minY + EPS), y1 = Math.floor(box.maxY - EPS);
  const z0 = Math.floor(box.minZ + EPS), z1 = Math.floor(box.maxZ - EPS);
  if (axis === 1) {
    if (delta > 0) {
      const yA = Math.floor(box.maxY), yB = Math.floor(box.maxY + delta);
      for (let y = yA; y <= yB; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        if (isSolidAt(world, x, y, z) && y >= box.maxY - EPS) delta = Math.min(delta, y - box.maxY - EPS);
      }
    } else {
      const yA = Math.floor(box.minY - EPS), yB = Math.floor(box.minY + delta);
      for (let y = yA; y >= yB; y--) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        if (isSolidAt(world, x, y, z) && y + 1 <= box.minY + EPS) delta = Math.max(delta, y + 1 - box.minY + EPS);
      }
    }
  } else if (axis === 0) {
    if (delta > 0) {
      const xA = Math.floor(box.maxX), xB = Math.floor(box.maxX + delta);
      for (let x = xA; x <= xB; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        if (isSolidAt(world, x, y, z) && x >= box.maxX - EPS) delta = Math.min(delta, x - box.maxX - EPS);
      }
    } else {
      const xA = Math.floor(box.minX - EPS), xB = Math.floor(box.minX + delta);
      for (let x = xA; x >= xB; x--) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        if (isSolidAt(world, x, y, z) && x + 1 <= box.minX + EPS) delta = Math.max(delta, x + 1 - box.minX + EPS);
      }
    }
  } else {
    if (delta > 0) {
      const zA = Math.floor(box.maxZ), zB = Math.floor(box.maxZ + delta);
      for (let z = zA; z <= zB; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (isSolidAt(world, x, y, z) && z >= box.maxZ - EPS) delta = Math.min(delta, z - box.maxZ - EPS);
      }
    } else {
      const zA = Math.floor(box.minZ - EPS), zB = Math.floor(box.minZ + delta);
      for (let z = zA; z >= zB; z--) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (isSolidAt(world, x, y, z) && z + 1 <= box.minZ + EPS) delta = Math.max(delta, z + 1 - box.minZ + EPS);
      }
    }
  }
  if (Math.abs(delta) < EPS) delta = 0;
  return delta;
}

/** Is there solid ground anywhere under the box's footprint? */
export function hasSupport(world, box) {
  const y = Math.floor(box.minY - 0.05);
  const x0 = Math.floor(box.minX + EPS), x1 = Math.floor(box.maxX - EPS);
  const z0 = Math.floor(box.minZ + EPS), z1 = Math.floor(box.maxZ - EPS);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (isSolidAt(world, x, y, z)) return true;
  return false;
}

/** Is the space above the box free up to `height` above its bottom? */
export function hasHeadroom(world, box, height) {
  const x0 = Math.floor(box.minX + EPS), x1 = Math.floor(box.maxX - EPS);
  const z0 = Math.floor(box.minZ + EPS), z1 = Math.floor(box.maxZ - EPS);
  const yTop = Math.floor(box.minY + height - EPS);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    for (let y = Math.floor(box.maxY); y <= yTop; y++) if (isSolidAt(world, x, y, z)) return false;
  }
  return true;
}

/** Does the box overlap any solid block? */
export function intersectsSolid(world, box) {
  const x0 = Math.floor(box.minX + EPS), x1 = Math.floor(box.maxX - EPS);
  const y0 = Math.floor(box.minY + EPS), y1 = Math.floor(box.maxY - EPS);
  const z0 = Math.floor(box.minZ + EPS), z1 = Math.floor(box.maxZ - EPS);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (isSolidAt(world, x, y, z)) return true;
  return false;
}

/**
 * Move a box with velocity over dt, Y first then X then Z. Returns { movedX, movedY, movedZ, onGround,
 * blockedX, blockedZ } and translates the box in place.
 */
export function moveBox(world, box, vx, vy, vz, dt, out) {
  const dx = vx * dt, dy = vy * dt, dz = vz * dt;
  const movedY = sweepAxis(world, box, 1, dy);
  box.translate(0, movedY, 0);
  const movedX = sweepAxis(world, box, 0, dx);
  box.translate(movedX, 0, 0);
  const movedZ = sweepAxis(world, box, 2, dz);
  box.translate(0, 0, movedZ);
  out.movedX = movedX; out.movedY = movedY; out.movedZ = movedZ;
  out.landed = dy < 0 && movedY !== dy;
  out.hitCeiling = dy > 0 && movedY !== dy;
  out.blockedX = dx !== 0 && movedX !== dx;
  out.blockedZ = dz !== 0 && movedZ !== dz;
  return out;
}
