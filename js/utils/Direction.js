// Direction.js — the six block faces, their normals, offsets and names. Worker-safe.

export const Direction = Object.freeze({
  EAST: 0,   // +X
  WEST: 1,   // -X
  UP: 2,     // +Y
  DOWN: 3,   // -Y
  SOUTH: 4,  // +Z
  NORTH: 5,  // -Z
});

export const DIRECTION_COUNT = 6;

/** Normal vectors indexed by direction id, as flat [x, y, z] triplets. */
export const DIR_OFFSETS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]);

export const DIR_NAMES = Object.freeze(['east', 'west', 'up', 'down', 'south', 'north']);

export const OPPOSITE = Object.freeze([1, 0, 3, 2, 5, 4]);

/** Compass label for a yaw angle (radians, 0 = looking toward -Z / north in this engine's convention). */
export function compassFromYaw(yaw) {
  // Forward vector: x = -sin(yaw), z = -cos(yaw)
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 'East (+X)' : 'West (-X)';
  return fz > 0 ? 'South (+Z)' : 'North (-Z)';
}
