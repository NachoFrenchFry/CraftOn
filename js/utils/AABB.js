// AABB.js — axis-aligned bounding box helpers (worker-safe, allocation-free where possible).

export class AABB {
  constructor(minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
  }

  set(minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
    return this;
  }

  copy(o) { return this.set(o.minX, o.minY, o.minZ, o.maxX, o.maxY, o.maxZ); }

  /** Box of a given width/height centered on (x, z) with its bottom at y. */
  setFromFeet(x, y, z, width, height) {
    const h = width / 2;
    return this.set(x - h, y, z - h, x + h, y + height, z + h);
  }

  translate(dx, dy, dz) {
    this.minX += dx; this.maxX += dx;
    this.minY += dy; this.maxY += dy;
    this.minZ += dz; this.maxZ += dz;
    return this;
  }

  intersectsBox(minX, minY, minZ, maxX, maxY, maxZ) {
    return this.minX < maxX && this.maxX > minX &&
      this.minY < maxY && this.maxY > minY &&
      this.minZ < maxZ && this.maxZ > minZ;
  }

  intersects(o) {
    return this.intersectsBox(o.minX, o.minY, o.minZ, o.maxX, o.maxY, o.maxZ);
  }

  containsPoint(x, y, z) {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY && z >= this.minZ && z <= this.maxZ;
  }

  get centerX() { return (this.minX + this.maxX) / 2; }
  get centerY() { return (this.minY + this.maxY) / 2; }
  get centerZ() { return (this.minZ + this.maxZ) / 2; }
}
