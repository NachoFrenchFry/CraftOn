// FaceTables.js — the six block faces as vertex tables shared by the chunk mesher, the liquid mesher and
// small block geometries: origin corner, u/v axes (u × v = outward normal → counter-clockwise), corner
// UVs, neighbour index offsets in the padded array and AO sample offsets. Worker-safe.

import { PADDED_SIZE, PADDED_STRIDE_Y } from '../config/Constants.js';

export const FACE_ORIGIN = [[1, 0, 1], [0, 0, 0], [0, 1, 1], [0, 0, 0], [0, 0, 1], [1, 0, 0]];
export const FACE_U = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
export const FACE_V = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];
export const FACE_N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

export const idxOff = (dx, dy, dz) => dx + dz * PADDED_SIZE + dy * PADDED_STRIDE_Y;

/** Neighbour index offset per face. */
export const NB_OFF = FACE_N.map(([x, y, z]) => idxOff(x, y, z));

/** CORNER_POS[face][corner] = [x, y, z] in {0,1}. */
export const CORNER_POS = [];
/** AO_OFF[face][corner] = [side1, side2, corner] index offsets. */
export const AO_OFF = [];
for (let f = 0; f < 6; f++) {
  const o = FACE_ORIGIN[f], u = FACE_U[f], v = FACE_V[f], n = FACE_N[f];
  CORNER_POS[f] = [];
  AO_OFF[f] = [];
  for (let c = 0; c < 4; c++) {
    const [iu, iv] = CORNER_UV[c];
    CORNER_POS[f][c] = [o[0] + iu * u[0] + iv * v[0], o[1] + iu * u[1] + iv * v[1], o[2] + iu * u[2] + iv * v[2]];
    const su = iu ? 1 : -1, sv = iv ? 1 : -1;
    const s1 = [n[0] + su * u[0], n[1] + su * u[1], n[2] + su * u[2]];
    const s2 = [n[0] + sv * v[0], n[1] + sv * v[1], n[2] + sv * v[2]];
    const cr = [n[0] + su * u[0] + sv * v[0], n[1] + su * u[1] + sv * v[1], n[2] + su * u[2] + sv * v[2]];
    AO_OFF[f][c] = [idxOff(...s1), idxOff(...s2), idxOff(...cr)];
  }
}
