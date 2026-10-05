// WaterLevels.js — water levels are encoded in block ids: WATER is a source (level 0), FLOWING_WATER_1..7
// weaken away from the source, FALLING_WATER flows downward. Pure helpers shared by the simulation,
// mesher and physics. Worker-safe.

import { BlockIds as B } from '../blocks/BlockIds.js';
import { WATER_SURFACE_HEIGHT, WATER_MAX_LEVEL } from '../config/Constants.js';

export function isWater(id) {
  return id === B.WATER || (id >= B.FLOWING_WATER_1 && id <= B.FALLING_WATER);
}

export function isSource(id) { return id === B.WATER; }
export function isFalling(id) { return id === B.FALLING_WATER; }

/** Flow decay: 0 for sources and falling water, 1..7 for flowing water, -1 for non-water. */
export function levelOf(id) {
  if (id === B.WATER || id === B.FALLING_WATER) return 0;
  if (id >= B.FLOWING_WATER_1 && id <= B.FLOWING_WATER_7) return id - B.FLOWING_WATER_1 + 1;
  return -1;
}

/** Block id for flowing water of a level 1..7. */
export function flowingId(level) {
  return B.FLOWING_WATER_1 + Math.min(WATER_MAX_LEVEL, Math.max(1, level)) - 1;
}

/** Rendered / physical surface height of a water block that has no water above it. */
export function heightOf(id) {
  if (id === B.WATER) return WATER_SURFACE_HEIGHT;
  if (id === B.FALLING_WATER) return 1;
  const level = levelOf(id);
  return level > 0 ? (8 - level) / 9 : 0;
}
