// BlockGeometry.js — builds a small THREE geometry for one block (cube with atlas UVs and baked face
// shading, or crossed quads for plants). Used by the held block, item entities and the crack overlay.

import * as THREE from 'three';
import { FACE_TILE, RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';
import { TILE_UVS } from './AtlasLayout.js';
import { FACE_BRIGHTNESS } from '../config/Constants.js';
import { Direction } from '../utils/Direction.js';

// Same face tables as ChunkMesher (kept local so this module stays independent of the mesher).
const FACE_ORIGIN = [[1, 0, 1], [0, 0, 0], [0, 1, 1], [0, 0, 0], [0, 0, 1], [1, 0, 0]];
const FACE_U = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
const FACE_V = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];
const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

const cache = new Map();

/**
 * @param {number} blockId
 * @param {number} size edge length
 * @param {boolean} centered center the geometry at the origin (else corner at origin)
 * @param {number|null} tileOverride atlas tile to use on every face (crack overlay)
 */
export function createBlockGeometry(blockId, size = 1, centered = true, tileOverride = null) {
  const key = `${blockId}:${size}:${centered}:${tileOverride}`;
  if (cache.has(key)) return cache.get(key);
  const positions = [], uvs = [], colors = [], indices = [];
  const off = centered ? -size / 2 : 0;
  let v = 0;
  const isCross = RENDER_TYPE[blockId] === RenderType.CROSS && tileOverride === null;
  if (isCross) {
    const t4 = FACE_TILE[blockId * 6 + Direction.SOUTH] * 4;
    const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
    const quads = [
      [[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 0]], [[1, 0, 1], [0, 0, 0], [0, 1, 0], [1, 1, 1]],
      [[1, 0, 0], [0, 0, 1], [0, 1, 1], [1, 1, 0]], [[0, 0, 1], [1, 0, 0], [1, 1, 0], [0, 1, 1]],
    ];
    for (const q of quads) {
      for (let c = 0; c < 4; c++) {
        const p = q[c];
        positions.push(p[0] * size + off, p[1] * size + off, p[2] * size + off);
        uvs.push(c === 1 || c === 2 ? u1 : u0, c >= 2 ? v1 : v0);
        colors.push(0.9, 0.9, 0.9);
      }
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  } else {
    for (let f = 0; f < 6; f++) {
      const tile = tileOverride !== null ? tileOverride : FACE_TILE[blockId * 6 + f];
      const t4 = tile * 4;
      const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
      const b = FACE_BRIGHTNESS[f];
      const o = FACE_ORIGIN[f], u = FACE_U[f], w = FACE_V[f];
      for (let c = 0; c < 4; c++) {
        const [iu, iv] = CORNER_UV[c];
        positions.push(
          (o[0] + iu * u[0] + iv * w[0]) * size + off,
          (o[1] + iu * u[1] + iv * w[1]) * size + off,
          (o[2] + iu * u[2] + iv * w[2]) * size + off,
        );
        uvs.push(iu ? u1 : u0, iv ? v1 : v0);
        colors.push(b, b, b);
      }
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeBoundingSphere();
  cache.set(key, geom);
  return geom;
}
