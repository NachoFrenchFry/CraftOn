// ItemSpriteGeometry.js — Minecraft-style 3D item sprites: every opaque pixel of a 16×16 item texture
// becomes a 1/16-thick voxel, with shaded sides only where the neighbouring pixel is transparent.
// Used for held non-block items (first and third person) and dropped item entities. Cached per texture.

import * as THREE from 'three';
import { getTileIndex, TILE_UVS, TILE_SIZE } from './AtlasLayout.js';
import { FACE_BRIGHTNESS } from '../config/Constants.js';
import { Direction } from '../utils/Direction.js';

const cache = new Map();
const ALPHA_THRESHOLD = 40;

/** Alpha mask of a tile canvas: Uint8Array(256), 1 = opaque. */
function alphaMask(atlas, textureName) {
  const tile = atlas.getTile(textureName);
  const data = tile.getContext('2d').getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  const mask = new Uint8Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > ALPHA_THRESHOLD ? 1 : 0;
  return mask;
}

/**
 * @param {import('./TextureAtlas.js').TextureAtlas} atlas
 * @param {string} textureName
 * @param {number} size world size of the 16-pixel sprite (centered on the origin)
 */
export function createItemSpriteGeometry(atlas, textureName, size = 1) {
  const key = `${textureName}:${size}`;
  if (cache.has(key)) return cache.get(key);
  const mask = alphaMask(atlas, textureName);
  const opaque = (px, py) => px >= 0 && py >= 0 && px < TILE_SIZE && py < TILE_SIZE && mask[py * TILE_SIZE + px] === 1;
  const t4 = getTileIndex(textureName) * 4;
  const u0 = TILE_UVS[t4], v1 = TILE_UVS[t4 + 3];
  const texel = (TILE_UVS[t4 + 2] - u0) / TILE_SIZE;
  const pixel = size / TILE_SIZE;
  const half = size / 2, thick = pixel / 2;
  const positions = [], uvs = [], colors = [], indices = [];
  let v = 0;
  const quad = (pts, uvList, shade) => {
    for (let i = 0; i < 4; i++) { positions.push(...pts[i]); uvs.push(...uvList[i]); colors.push(shade, shade, shade); }
    indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      if (!opaque(px, py)) continue;
      const x0 = -half + px * pixel, x1 = x0 + pixel;
      const y1 = half - py * pixel, y0 = y1 - pixel;
      const z0 = -thick, z1 = thick;
      const uL = u0 + px * texel, uR = uL + texel;
      const vT = v1 - py * texel, vB = vT - texel;
      const uc = (uL + uR) / 2, vc = (vT + vB) / 2;
      const flat = [[uc, vc], [uc, vc], [uc, vc], [uc, vc]];
      // Front (+Z) and back (-Z) always.
      quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[uL, vB], [uR, vB], [uR, vT], [uL, vT]], 1.0);
      quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [[uR, vB], [uL, vB], [uL, vT], [uR, vT]], 1.0);
      // Sides only where the neighbouring pixel is transparent.
      if (!opaque(px + 1, py)) quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], flat, FACE_BRIGHTNESS[Direction.EAST]);
      if (!opaque(px - 1, py)) quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], flat, FACE_BRIGHTNESS[Direction.WEST]);
      if (!opaque(px, py - 1)) quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], flat, FACE_BRIGHTNESS[Direction.UP]);
      if (!opaque(px, py + 1)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], flat, FACE_BRIGHTNESS[Direction.DOWN]);
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

/** Geometry for any item: a block cube for block items, an extruded sprite otherwise. */
export function createItemGeometry(atlas, itemRegistry, createBlockGeometry, itemId, size) {
  const item = itemRegistry.get(itemId);
  if (!item) return null;
  if (item.isBlock) return createBlockGeometry(item.blockId, size);
  return createItemSpriteGeometry(atlas, item.texture, size);
}
