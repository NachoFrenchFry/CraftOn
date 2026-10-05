// BlockRaycaster.js — voxel DDA (Amanatides & Woo) from an origin along a direction; returns the first
// targetable block, the face hit and the placement position. Water is ignored, plants are targetable.

import { BlockIds } from '../blocks/BlockIds.js';
import { RENDER_TYPE, RenderType, SOLID } from '../blocks/BlockRegistry.js';

export class RaycastHit {
  constructor() {
    this.hit = false;
    this.blockId = 0;
    this.blockPos = { x: 0, y: 0, z: 0 };
    this.faceNormal = { x: 0, y: 0, z: 0 };
    this.placePos = { x: 0, y: 0, z: 0 };
    this.distance = 0;
  }

  samePosition(o) {
    return this.hit === o.hit && this.blockPos.x === o.blockPos.x && this.blockPos.y === o.blockPos.y && this.blockPos.z === o.blockPos.z;
  }
}

/** Shared DDA state to avoid allocations. */
const dda = { x: 0, y: 0, z: 0, stepX: 0, stepY: 0, stepZ: 0, tMaxX: 0, tMaxY: 0, tMaxZ: 0, tDeltaX: 0, tDeltaY: 0, tDeltaZ: 0 };

function ddaInit(ox, oy, oz, dx, dy, dz) {
  const s = dda;
  s.x = Math.floor(ox); s.y = Math.floor(oy); s.z = Math.floor(oz);
  s.stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  s.stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  s.stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  s.tDeltaX = s.stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  s.tDeltaY = s.stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  s.tDeltaZ = s.stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
  s.tMaxX = s.stepX > 0 ? (s.x + 1 - ox) / dx : s.stepX < 0 ? (s.x - ox) / dx : Infinity;
  s.tMaxY = s.stepY > 0 ? (s.y + 1 - oy) / dy : s.stepY < 0 ? (s.y - oy) / dy : Infinity;
  s.tMaxZ = s.stepZ > 0 ? (s.z + 1 - oz) / dz : s.stepZ < 0 ? (s.z - oz) / dz : Infinity;
}

/** Advance one cell; returns the distance travelled so far and sets the entered face normal. */
function ddaStep(n) {
  const s = dda;
  let t;
  if (s.tMaxX < s.tMaxY && s.tMaxX < s.tMaxZ) {
    t = s.tMaxX; s.x += s.stepX; s.tMaxX += s.tDeltaX; n.x = -s.stepX; n.y = 0; n.z = 0;
  } else if (s.tMaxY < s.tMaxZ) {
    t = s.tMaxY; s.y += s.stepY; s.tMaxY += s.tDeltaY; n.x = 0; n.y = -s.stepY; n.z = 0;
  } else {
    t = s.tMaxZ; s.z += s.stepZ; s.tMaxZ += s.tDeltaZ; n.x = 0; n.y = 0; n.z = -s.stepZ;
  }
  return t;
}

export class BlockRaycaster {
  /** @param {import('../world/World.js').World} world */
  constructor(world) {
    this.world = world;
    this._n = { x: 0, y: 0, z: 0 };
  }

  static targetable(id, includeWater = false) {
    return id !== BlockIds.AIR && (includeWater || RENDER_TYPE[id] !== RenderType.LIQUID);
  }

  /**
   * Cast from (ox, oy, oz) along (dx, dy, dz) up to maxDistance blocks.
   * @param {RaycastHit} out
   */
  cast(ox, oy, oz, dx, dy, dz, maxDistance, out, includeWater = false) {
    out.hit = false;
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return out;
    dx /= len; dy /= len; dz /= len;
    ddaInit(ox, oy, oz, dx, dy, dz);
    const n = this._n;
    n.x = 0; n.y = 1; n.z = 0;
    let t = 0;
    for (let i = 0; i < 512; i++) {
      const s = dda;
      if (s.y >= 0 && s.y < 256) {
        const id = this.world.getBlock(s.x, s.y, s.z);
        if (BlockRaycaster.targetable(id, includeWater)) {
          out.hit = true;
          out.blockId = id;
          out.blockPos.x = s.x; out.blockPos.y = s.y; out.blockPos.z = s.z;
          out.faceNormal.x = n.x; out.faceNormal.y = n.y; out.faceNormal.z = n.z;
          out.placePos.x = s.x + n.x; out.placePos.y = s.y + n.y; out.placePos.z = s.z + n.z;
          out.distance = t;
          return out;
        }
      }
      t = ddaStep(n);
      if (t > maxDistance) break;
    }
    return out;
  }

  /** Distance along the ray to the first solid cube (camera collision), or maxDistance. */
  solidDistance(ox, oy, oz, dx, dy, dz, maxDistance) {
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return 0;
    dx /= len; dy /= len; dz /= len;
    ddaInit(ox, oy, oz, dx, dy, dz);
    const n = this._n;
    let t = 0;
    for (let i = 0; i < 64; i++) {
      const s = dda;
      const id = this.world.getBlock(s.x, s.y, s.z);
      if (i > 0 && SOLID[id] === 1 && RENDER_TYPE[id] === RenderType.CUBE) return t;
      t = ddaStep(n);
      if (t > maxDistance) return maxDistance;
    }
    return maxDistance;
  }
}
