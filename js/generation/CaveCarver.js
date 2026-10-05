// CaveCarver.js — classic Minecraft-style worm tunnels and rooms (after MapGenCaves). Every chunk
// within radius 8 may spawn systems that carve only the blocks inside the current chunk, so
// tunnels cross chunk borders seamlessly. Worker-safe.

import { Random, chunkRandom } from '../utils/Random.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { MIN_CAVE_Y, CAVE_CHUNK_CHANCE, CAVE_ROOM_CHANCE } from '../config/Constants.js';

const RANGE = 8;
const SALT = 0xca7e5;

export class CaveCarver {
  constructor(seed) {
    this.seed = seed;
  }

  /**
   * @param {Uint8Array} blocks chunk block array
   * @param {Int16Array} carveMaxY per-column highest y that may be carved (256 entries, 16×16)
   */
  carve(blocks, cx, cz, carveMaxY) {
    this.blocks = blocks;
    this.carveMaxY = carveMaxY;
    this.minX = cx * 16; this.minZ = cz * 16;
    this.maxX = this.minX + 15; this.maxZ = this.minZ + 15;
    this.centerX = this.minX + 8; this.centerZ = this.minZ + 8;
    for (let scx = cx - RANGE; scx <= cx + RANGE; scx++) {
      for (let scz = cz - RANGE; scz <= cz + RANGE; scz++) {
        this._sourceChunk(scx, scz);
      }
    }
  }

  _sourceChunk(scx, scz) {
    const rng = chunkRandom(this.seed, scx, scz, SALT);
    let count = 1 + rng.nextInt(rng.nextInt(rng.nextInt(8) + 1) + 1);
    if (rng.nextInt(CAVE_CHUNK_CHANCE) !== 0) count = 0;
    for (let i = 0; i < count; i++) {
      const x = scx * 16 + rng.nextInt(16);
      const y = rng.nextInt(rng.nextInt(120) + 8);
      const z = scz * 16 + rng.nextInt(16);
      let tunnels = rng.nextInt(4) === 0 ? 2 : 1;
      if (rng.nextInt(CAVE_ROOM_CHANCE) === 0) {
        this._room(rng.nextUint32(), x, y, z, 2 + rng.next() * 5);
        tunnels += rng.nextInt(4);
      }
      for (let j = 0; j < tunnels; j++) {
        const yaw = rng.next() * Math.PI * 2;
        const pitch = (rng.next() - 0.5) * 2 / 8;
        let width = rng.next() * 2 + rng.next();
        if (rng.nextInt(10) === 0) width *= rng.next() * rng.next() * 3 + 1;
        this._tunnel(rng.nextUint32(), x, y, z, width, yaw, pitch, 0, 0, 1);
      }
    }
  }

  _room(seed, x, y, z, radius) {
    const rng = new Random(seed);
    this._tunnel(seed, x, y, z, radius, rng.next() * Math.PI * 2, 0, -1, -1, 0.5, true);
  }

  _tunnel(seed, x, y, z, width, yaw, pitch, step, length, heightRatio, isRoom = false) {
    const rng = new Random(seed);
    if (length <= 0) length = 112 - rng.nextInt(28);
    if (step === -1) { step = length / 2; }
    const branchStep = rng.nextInt(Math.floor(length / 2)) + Math.floor(length / 4);
    const steep = rng.nextInt(6) === 0;
    let yawDelta = 0, pitchDelta = 0;
    for (; step < length; step++) {
      const r = 1.5 + Math.sin((step * Math.PI) / length) * width;
      const rv = r * heightRatio;
      const cosPitch = Math.cos(pitch);
      x += Math.cos(yaw) * cosPitch;
      y += Math.sin(pitch);
      z += Math.sin(yaw) * cosPitch;
      pitch *= steep ? 0.92 : 0.7;
      pitch += pitchDelta * 0.1;
      yaw += yawDelta * 0.1;
      pitchDelta *= 0.9;
      yawDelta *= 0.75;
      pitchDelta += (rng.next() - rng.next()) * rng.next() * 2;
      yawDelta += (rng.next() - rng.next()) * rng.next() * 4;

      if (!isRoom && step === branchStep && width > 1 && length > 0) {
        this._tunnel(rng.nextUint32(), x, y, z, rng.next() * 0.5 + 0.5, yaw - Math.PI / 2, pitch / 3, step, length, 1);
        this._tunnel(rng.nextUint32(), x, y, z, rng.next() * 0.5 + 0.5, yaw + Math.PI / 2, pitch / 3, step, length, 1);
        return;
      }
      if (!isRoom && rng.nextInt(4) === 0) continue;

      // Cheap reachability test: can this worm still touch our chunk?
      const dx = x - this.centerX, dz = z - this.centerZ;
      const remaining = length - step;
      const reach = width + 2 + 16;
      if (dx * dx + dz * dz - remaining * remaining > reach * reach) return;

      if (x + r < this.minX - 1 || x - r > this.maxX + 1 || z + r < this.minZ - 1 || z - r > this.maxZ + 1) continue;
      this._carveEllipsoid(x, y, z, r, rv);
      if (isRoom) return;
    }
  }

  _carveEllipsoid(x, y, z, r, rv) {
    const blocks = this.blocks;
    const x0 = Math.max(Math.floor(x - r) - 1, this.minX), x1 = Math.min(Math.floor(x + r) + 1, this.maxX);
    const z0 = Math.max(Math.floor(z - r) - 1, this.minZ), z1 = Math.min(Math.floor(z + r) + 1, this.maxZ);
    const y0 = Math.max(Math.floor(y - rv) - 1, MIN_CAVE_Y), y1 = Math.min(Math.floor(y + rv) + 1, 250);
    for (let bx = x0; bx <= x1; bx++) {
      const ddx = (bx + 0.5 - x) / r;
      const ddx2 = ddx * ddx;
      if (ddx2 >= 1) continue;
      for (let bz = z0; bz <= z1; bz++) {
        const ddz = (bz + 0.5 - z) / r;
        const dxz = ddx2 + ddz * ddz;
        if (dxz >= 1) continue;
        const lx = bx - this.minX, lz = bz - this.minZ;
        const col = lx + (lz << 4);
        const maxY = Math.min(y1, this.carveMaxY[col]);
        for (let by = y0; by <= maxY; by++) {
          const ddy = (by - 1 + 0.5 - y) / rv;
          // Taper the tunnel toward the cave floor so it never cuts straight down onto bedrock.
          const floorT = Math.min(1, (by - MIN_CAVE_Y + 1) / 4);
          if (ddy > -0.7 && dxz + ddy * ddy < floorT * floorT) {
            const i = col + (by << 8);
            const id = blocks[i];
            if (id !== B.BEDROCK && id !== B.WATER && id !== B.AIR) blocks[i] = B.AIR;
          }
        }
      }
    }
  }
}
