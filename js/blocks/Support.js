// Support.js — which block holds another up (Update #11): plants and standing torches need the block below,
// wall torches the wall they hang on. Shared by placement (BlockInteraction, the host's validation), breaking
// (the dependents of a removed block break too) and the liquid simulation. Pure.
import { BlockIds } from './BlockIds.js';
import { SOLID, OPAQUE, RENDER_TYPE, RenderType, BlockRegistry } from './BlockRegistry.js';

/** Offsets of the cells whose block may depend on the block at the origin: above, and the four sides (wall torches). */
export const DEPENDENT_OFFSETS = Object.freeze([[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]);

/** A full, solid, non-transparent cube (what a torch may hang on). */
export function isFullCube(id) { return OPAQUE[id] === 1 && SOLID[id] === 1 && RENDER_TYPE[id] === RenderType.CUBE; }

/** True when block `id` placed at (x, y, z) has what it needs under / behind it. */
export function isSupported(world, x, y, z, id) {
  const d = BlockRegistry.supportDir(id);
  if (!d) return true;
  const s = world.getBlock(x + d[0], y + d[1], z + d[2]);
  return BlockRegistry.isTorch(id) ? isFullCube(s) : SOLID[s] === 1;
}

/** True when block `id` sitting at offset (dx, dy, dz) from a cell depends on that cell. */
export function dependsOnOffset(id, dx, dy, dz) {
  if (id === BlockIds.AIR) return false;
  const d = BlockRegistry.supportDir(id);
  return !!d && d[0] === -dx && d[1] === -dy && d[2] === -dz;
}

/** Call `breakAt(x, y, z)` for every block around (x, y, z) that was held up by it. */
export function breakDependents(world, x, y, z, breakAt) {
  for (const [dx, dy, dz] of DEPENDENT_OFFSETS) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (dependsOnOffset(world.getBlock(nx, ny, nz), dx, dy, dz)) breakAt(nx, ny, nz);
  }
}
