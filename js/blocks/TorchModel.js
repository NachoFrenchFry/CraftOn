// TorchModel.js — the torch block model (Update #11): a 2×10×2 px stick with a crossed flame tip above it, all
// sampled from the `torch` item texture. A standing torch sits in the middle of its cell; a wall torch hangs on
// the wall to its `attach` side (north / south / east / west), its base raised 3 px and leaning about 22° into
// the room, like Minecraft. Pure geometry: the mesher (in the worker) builds the quads, the selection box uses
// the bounds, the particle effects use the flame tip. Coordinates are block-local (0..1), UVs are fractions of
// the 16×16 texture (u right, v up from the bottom row).
export const TORCH_TILT = 22.5 * Math.PI / 180;
/** Direction toward the wall a torch hangs on. */
export const WALL_DIR = Object.freeze({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] });
const PX = 1 / 16;

/** The standing torch's quads: arrays of 4 corners [x, y, z, u, v], counter-clockwise seen from outside. */
function standingQuads() {
  const q = [];
  const x0 = 7 * PX, x1 = 9 * PX, z0 = 7 * PX, z1 = 9 * PX, top = 10 * PX;
  const su0 = 7 * PX, su1 = 9 * PX, sv0 = 0, sv1 = 10 * PX;           // stick sides: texture columns 7..9, rows 6..16
  // Four sides (normal +x, -x, +z, -z).
  q.push([[x1, 0, z1, su0, sv0], [x1, 0, z0, su1, sv0], [x1, top, z0, su1, sv1], [x1, top, z1, su0, sv1]]);
  q.push([[x0, 0, z0, su0, sv0], [x0, 0, z1, su1, sv0], [x0, top, z1, su1, sv1], [x0, top, z0, su0, sv1]]);
  q.push([[x0, 0, z1, su0, sv0], [x1, 0, z1, su1, sv0], [x1, top, z1, su1, sv1], [x0, top, z1, su0, sv1]]);
  q.push([[x1, 0, z0, su0, sv0], [x0, 0, z0, su1, sv0], [x0, top, z0, su1, sv1], [x1, top, z0, su0, sv1]]);
  // Top (the ember rows 6..8) and bottom (rows 14..16).
  q.push([[x0, top, z1, su0, 8 * PX], [x1, top, z1, su1, 8 * PX], [x1, top, z0, su1, 10 * PX], [x0, top, z0, su0, 10 * PX]]);
  q.push([[x0, 0, z0, su0, 0], [x1, 0, z0, su1, 0], [x1, 0, z1, su1, 2 * PX], [x0, 0, z1, su0, 2 * PX]]);
  // The flame: two crossed quads (both windings, so they show from every side) sampling columns 6..10, rows 1..6.
  const fx0 = 6 * PX, fx1 = 10 * PX, fy0 = 10 * PX, fy1 = 15 * PX, fu0 = 6 * PX, fu1 = 10 * PX, fv0 = 10 * PX, fv1 = 15 * PX;
  const a = [[fx0, fy0, 0.5, fu0, fv0], [fx1, fy0, 0.5, fu1, fv0], [fx1, fy1, 0.5, fu1, fv1], [fx0, fy1, 0.5, fu0, fv1]];
  const b = [[0.5, fy0, fx1, fu0, fv0], [0.5, fy0, fx0, fu1, fv0], [0.5, fy1, fx0, fu1, fv1], [0.5, fy1, fx1, fu0, fv1]];
  q.push(a, [a[1], a[0], a[3], a[2]], b, [b[1], b[0], b[3], b[2]]);
  return q;
}

/** Move a standing-torch point onto the wall torch of `attach`: pivot at the base centre, lean TORCH_TILT into the room. */
function toWall(p, attach) {
  const [wx, wz] = WALL_DIR[attach];
  const dx = -wx, dz = -wz;           // lean direction (away from the wall)
  const sx = -wz, sz = wx;            // the perpendicular
  const hx = p[0] - 0.5, hz = p[2] - 0.5, hy = p[1];
  const a = hx * dx + hz * dz, s = hx * sx + hz * sz;
  const c = Math.cos(TORCH_TILT), n = Math.sin(TORCH_TILT);
  const a2 = a * c + hy * n, y2 = -a * n + hy * c;
  const bx = 0.5 + wx * (0.5 - 2 * PX), bz = 0.5 + wz * (0.5 - 2 * PX), by = 3 * PX;
  return [bx + dx * a2 + sx * s, by + y2, bz + dz * a2 + sz * s, p[3], p[4]];
}

const cache = new Map();
/**
 * Quads of a torch with the given attach side (null = standing): [[x, y, z, u, v] × 4, ...].
 * @param {string|null} attach
 */
export function torchQuads(attach = null) {
  const key = attach || 'up';
  let q = cache.get(key);
  if (q) return q;
  q = standingQuads();
  if (attach) q = q.map((quad) => quad.map((p) => toWall(p, attach)));
  cache.set(key, q);
  return q;
}

/** Axis-aligned bounds of the model (block-local): { min: [x, y, z], max: [x, y, z] }. */
export function torchBounds(attach = null) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const quad of torchQuads(attach)) for (const p of quad) for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
  return { min, max };
}

/** Where the flame sits (block-local): the top of the stick. */
export function torchTip(attach = null) {
  const p = [0.5, 11 * PX, 0.5, 0, 0];
  return attach ? toWall(p, attach) : p;
}
