// MobModel.js — builds a mob's box model from its definition (Cow.js / Pig.js / Sheep.js) with
// Minecraft box-UV nets mapped onto BoxGeometry faces. Lambert materials get the same scene lighting
// as the player model. Also loads the entity sheets (NearestFilter, pixelated).
//
// Orientation rule: every sheet is drawn into a <canvas> before it becomes a texture. WebGL ignores
// `flipY` for ImageBitmap sources, while applyNetUVs() computes v = 1 - y / sheetH (flipY = true), so a
// texture made straight from an ImageBitmap samples the sheet upside down and faces land on empty
// (alpha-tested) areas — the mobs looked hollow. TextureAtlas.js draws its bitmaps into the atlas canvas
// for the same reason.

import * as THREE from 'three';
import { MOB_PX } from '../../config/Constants.js';
import { TEXTURE_FILES, ENTITY_TEXTURES, ENTITY_TEXTURE_SIZE, ARMOR_TEXTURES } from '../../config/TextureManifest.js';
import { netRects } from './MobNet.js';

// BoxGeometry face groups in order: +X, -X, +Y, -Y, +Z, -Z. Each face has 4 vertices whose UVs are
// laid out top-left, top-right, bottom-left, bottom-right as seen from outside the box.
const FACE_FOR_GROUP = ['right', 'left', 'top', 'bottom', 'back', 'front'];

/** Map a BoxGeometry's UVs onto the net of a W×H×D box at (u, v) on a sheetW×sheetH sheet. */
export function applyNetUVs(geometry, u, v, W, H, D, sheetW = ENTITY_TEXTURE_SIZE[0], sheetH = ENTITY_TEXTURE_SIZE[1]) {
  const rects = {};
  for (const r of netRects(u, v, W, H, D)) rects[r.name] = r;
  const uv = geometry.getAttribute('uv');
  for (let g = 0; g < 6; g++) {
    const r = rects[FACE_FOR_GROUP[g]];
    const u0 = r.x / sheetW, u1 = (r.x + r.w) / sheetW;
    const v0 = 1 - r.y / sheetH, v1 = 1 - (r.y + r.h) / sheetH; // flipY: v0 is the rect's top
    const base = g * 4;
    uv.setXY(base, u0, v0); uv.setXY(base + 1, u1, v0); uv.setXY(base + 2, u0, v1); uv.setXY(base + 3, u1, v1);
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Load every entity sheet — the mob sheets (keys 'cow', 'pig', 'sheep', 'sheep_wool') and the armor sheets
 * (keys 'armor/wooden_layer_1' …) — as Map<key, THREE.Texture>. Missing files log a warning and use a magenta fill.
 */
export async function loadEntityTextures() {
  const out = new Map();
  const entries = [...ENTITY_TEXTURES.map((n) => ['entity/' + n, n]), ...ARMOR_TEXTURES.map((n) => ['entity/armor/' + n, 'armor/' + n])];
  await Promise.all(entries.map(async ([file, name]) => {
    let tex;
    try {
      const res = await fetch(TEXTURE_FILES[file], { cache: 'reload' });
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const bitmap = await createImageBitmap(await res.blob());
      const c = document.createElement('canvas');
      c.width = bitmap.width; c.height = bitmap.height;
      c.getContext('2d').drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      tex = new THREE.CanvasTexture(c); // flipY = true is honoured for canvases
    } catch (e) {
      console.warn(`MobModel: entity texture ${name} failed to load (${e.message}); run "node tools/export-textures.mjs"`);
      const c = document.createElement('canvas'); c.width = 64; c.height = 32;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 64, 32);
      tex = new THREE.CanvasTexture(c);
    }
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    out.set(name, tex);
  }));
  return out;
}

/** @deprecated alias of loadEntityTextures (the map also holds the armor sheets). */
export const loadMobTextures = loadEntityTextures;

/**
 * Build a mob model. Returns { root, pivots: Map<partName, Group>, materials: Material[] }.
 * Materials are per instance so hurt flashes don't affect other mobs.
 */
export function createMobModel(def, textures) {
  const root = new THREE.Group();
  const pivots = new Map();
  const materials = [];
  const matFor = new Map();
  const material = (layer) => {
    const key = layer || 'base';
    if (!matFor.has(key)) {
      const texName = layer === 'wool' ? def.woolTexture : def.texture;
      const m = new THREE.MeshLambertMaterial({ map: textures.get(texName) || null, alphaTest: 0.5, transparent: false, side: THREE.FrontSide });
      matFor.set(key, m);
      materials.push(m);
    }
    return matFor.get(key);
  };
  for (const part of def.parts) {
    const [W, H, D] = part.size;
    const inflate = part.inflate || 0;
    const geom = new THREE.BoxGeometry((W + 2 * inflate) * MOB_PX, (H + 2 * inflate) * MOB_PX, (D + 2 * inflate) * MOB_PX);
    applyNetUVs(geom, part.uv[0], part.uv[1], W, H, D);
    const mesh = new THREE.Mesh(geom, material(part.layer));
    mesh.position.set(part.offset[0] * MOB_PX, part.offset[1] * MOB_PX, part.offset[2] * MOB_PX);
    if (part.rotX) mesh.rotation.x = part.rotX;
    const pivot = new THREE.Group();
    pivot.position.set(part.pivot[0] * MOB_PX, part.pivot[1] * MOB_PX, part.pivot[2] * MOB_PX);
    pivot.add(mesh);
    (part.parent ? pivots.get(part.parent) : root).add(pivot);
    pivots.set(part.name, pivot);
  }
  return { root, pivots, materials };
}
