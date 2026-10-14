// RayBox.js — ray / axis-aligned box slab test without allocations: the mob and remote-player raycasts
// run every frame from BlockInteraction. Returns the entry distance along the ray, or -1 when the ray misses the box
// or enters beyond `maxT`.
export function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxT) {
  let tmin = 0, tmax = maxT;
  if (Math.abs(dx) < 1e-9) { if (ox < minX || ox > maxX) return -1; } else { let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
  if (Math.abs(dy) < 1e-9) { if (oy < minY || oy > maxY) return -1; } else { let t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
  if (Math.abs(dz) < 1e-9) { if (oz < minZ || oz > maxZ) return -1; } else { let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
  return tmin;
}
