// Pathfinder.js — a small A* over standable cells for the zombies (good enough for caves): a cell is standable when the
// block under it is solid, the cell and the one above are free of solid blocks and liquids, and no lava lies under or
// in it. Moves go to the four horizontal neighbours, up one step (a jump) or down up to MOB_MAX_DROP blocks; everything
// stays inside a box of ±radius blocks around the start, and the search gives up after `maxNodes` expansions or when its
// time budget runs out (MobManager hands every search of a physics step the same budget). Pure over world.getBlock.

import { SOLID } from '../../blocks/BlockRegistry.js';
import { isLava, isLiquid } from '../../world/WaterLevels.js';
import { MOB_MAX_DROP } from '../../config/Constants.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const key = (x, y, z) => ((x + 512) & 1023) | (((z + 512) & 1023) << 10) | ((y & 255) << 20);

/** Can a mob stand with its feet in cell (x, y, z)? */
export function standable(world, x, y, z) {
  if (y < 1) return false;
  const below = world.getBlock(x, y - 1, z), here = world.getBlock(x, y, z), above = world.getBlock(x, y + 1, z);
  if (SOLID[below] !== 1 || SOLID[here] === 1 || SOLID[above] === 1) return false;
  if (isLiquid(here) || isLiquid(above) || isLava(below)) return false;
  return true;
}

/** The standable cell a walker reaches from (x, y, z) moving to (nx, nz): the same level, one up, or down up to the max drop; null when none. */
function stepTo(world, nx, y, nz) {
  if (standable(world, nx, y, nz)) return y;
  if (standable(world, nx, y + 1, nz) && SOLID[world.getBlock(nx, y + 2, nz)] !== 1) return y + 1; // a one-block jump needs headroom above the step
  for (let d = 1; d <= MOB_MAX_DROP; d++) {
    const yy = y - d;
    if (SOLID[world.getBlock(nx, yy, nz)] === 1) return null; // ran into the ground without a standable cell
    if (isLava(world.getBlock(nx, yy, nz))) return null;
    if (standable(world, nx, yy, nz)) return yy;
  }
  return null;
}

/**
 * A* from the start cell toward the target cell. Returns an array of [x, y, z] cells (excluding the start) ending at the
 * target or, when the target is unreachable within the limits, at the explored cell closest to it; [] when nothing beats
 * the start. `deadline` is a performance.now() time.
 */
export function findPath(world, sx, sy, sz, tx, ty, tz, { radius = 16, maxNodes = 400, deadline = Infinity } = {}) {
  const h = (x, y, z) => Math.abs(x - tx) + Math.abs(z - tz) + Math.abs(y - ty) * 0.5;
  const open = [];
  const best = new Map(); // key → { x, y, z, g, f, parent }
  const start = { x: sx, y: sy, z: sz, g: 0, f: h(sx, sy, sz), parent: null, closed: false };
  best.set(key(sx, sy, sz), start);
  open.push(start);
  let nearest = start, expanded = 0;
  while (open.length) {
    // the open list is tiny (≤ maxNodes): a linear scan for the lowest f beats a heap here
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1]; open.pop();
    if (cur.closed) continue;
    cur.closed = true;
    if (cur.x === tx && cur.z === tz && Math.abs(cur.y - ty) <= 1) { nearest = cur; break; }
    if (h(cur.x, cur.y, cur.z) < h(nearest.x, nearest.y, nearest.z)) nearest = cur;
    if (++expanded >= maxNodes || ((expanded & 15) === 0 && now() > deadline)) break;
    for (let d = 0; d < 4; d++) {
      const nx = cur.x + DIRS[d][0], nz = cur.z + DIRS[d][1];
      if (Math.abs(nx - sx) > radius || Math.abs(nz - sz) > radius) continue;
      const ny = stepTo(world, nx, cur.y, nz);
      if (ny === null) continue;
      const g = cur.g + 1 + Math.abs(ny - cur.y) * 0.5;
      const k = key(nx, ny, nz);
      const seen = best.get(k);
      if (seen && seen.g <= g) continue;
      const node = { x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), parent: cur, closed: false };
      best.set(k, node);
      open.push(node);
    }
  }
  const path = [];
  for (let n = nearest; n && n !== start; n = n.parent) path.push([n.x, n.y, n.z]);
  path.reverse();
  return path;
}
