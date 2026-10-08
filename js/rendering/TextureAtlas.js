// TextureAtlas.js — loads every texture PNG listed in TextureManifest (fresh, never stale-cached),
// packs them into one power-of-two atlas canvas and exposes UV lookups + per-tile canvases.
// Missing files fall back to a magenta/black checker (one grouped warning); wrong sizes are
// nearest-neighbour scaled to the tile size (warning).

import * as THREE from 'three';
import { TEXTURE_FILES, DERIVED_TEXTURES } from '../config/TextureManifest.js';
import { TEXTURE_NAMES, TILE_SIZE, ATLAS_SIZE, MISSING_TEXTURE, getUV, tileColumn, tileRow, getTileIndex } from './AtlasLayout.js';
import { BlockRegistry, OPAQUE, RENDER_TYPE, RenderType, markCutout } from '../blocks/BlockRegistry.js';

/** Fetch a PNG bypassing the HTTP cache so edited files show up on a plain reload. */
async function loadBitmap(path) {
  const res = await fetch(path, { cache: 'reload' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

/** Copy a bitmap into a fresh tile canvas, scaling with nearest-neighbour if it isn't 16×16. */
function toTileCanvas(bitmap) {
  const c = document.createElement('canvas');
  c.width = TILE_SIZE;
  c.height = TILE_SIZE;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, TILE_SIZE, TILE_SIZE);
  return c;
}

/** The classic magenta/black checker, generated in code because it exists for when files fail. */
function makeMissingTile() {
  const c = document.createElement('canvas');
  c.width = TILE_SIZE;
  c.height = TILE_SIZE;
  const ctx = c.getContext('2d');
  for (let y = 0; y < TILE_SIZE; y += 8) for (let x = 0; x < TILE_SIZE; x += 8) {
    ctx.fillStyle = ((x + y) / 8) % 2 === 0 ? '#ff00ff' : '#000000';
    ctx.fillRect(x, y, 8, 8);
  }
  return c;
}

export class TextureAtlas {
  constructor() {
    this.canvas = null;
    this.texture = null;
    /** name → 16×16 canvas (used by icons, particles, debug view) */
    this.tiles = new Map();
    this.missingNames = [];
    this.resizedNames = [];
    this.loaded = false;
    /** Block ids switched to the cutout pass because a texture has transparent pixels. */
    this.cutoutBlocks = [];
  }

  /** Does a tile canvas contain any pixel with alpha below 255? */
  hasTransparency(name) {
    const tile = this.tiles.get(name);
    if (!tile) return false;
    const data = tile.getContext('2d').getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  }

  /** Future-proofing: an opaque cube block whose texture gained transparency renders as a cutout. */
  _detectTransparentBlocks() {
    const transparent = new Set(TEXTURE_NAMES.filter((n) => this.hasTransparency(n)));
    for (const def of BlockRegistry.all()) {
      if (OPAQUE[def.id] !== 1 || RENDER_TYPE[def.id] !== RenderType.CUBE) continue;
      for (let f = 0; f < 6; f++) {
        if (transparent.has(BlockRegistry.faceTexture(def.id, f))) { markCutout(def.id); this.cutoutBlocks.push(def.id); break; }
      }
    }
    if (this.cutoutBlocks.length) {
      console.info(`TextureAtlas: rendering ${this.cutoutBlocks.map((id) => BlockRegistry.nameOf(id)).join(', ')} with alpha testing because the texture has transparent pixels.`);
    }
  }

  /** Load all textures and build the atlas. Resolves when the atlas texture is ready. */
  async load() {
    const missingTile = makeMissingTile();
    this.tiles.set(MISSING_TEXTURE, missingTile);
    const names = TEXTURE_NAMES.filter((n) => n !== MISSING_TEXTURE && !DERIVED_TEXTURES.includes(n));
    await Promise.all(names.map(async (name) => {
      const path = TEXTURE_FILES[name];
      if (!path) { this.missingNames.push(`${name} (not in TextureManifest)`); this.tiles.set(name, missingTile); return; }
      try {
        const bitmap = await loadBitmap(path);
        if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) this.resizedNames.push(`${path} is ${bitmap.width}×${bitmap.height}`);
        this.tiles.set(name, toTileCanvas(bitmap));
        bitmap.close();
      } catch (e) {
        this.missingNames.push(`${path} (${e.message})`);
        this.tiles.set(name, missingTile);
      }
    }));
    if (this.missingNames.length) {
      console.warn(`TextureAtlas: ${this.missingNames.length} texture file(s) could not be loaded, showing the missing-texture checker instead. Run "node tools/export-textures.mjs" to regenerate:\n  ${this.missingNames.join('\n  ')}`);
    }
    if (this.resizedNames.length) {
      console.warn(`TextureAtlas: ${this.resizedNames.length} texture(s) are not ${TILE_SIZE}×${TILE_SIZE} and were scaled (nearest-neighbour):\n  ${this.resizedNames.join('\n  ')}`);
    }
    this._deriveTiles();
    this._detectTransparentBlocks();
    this._compose();
    this.loaded = true;
    return this;
  }

  /** Derived tiles (DERIVED_TEXTURES): 'leaves_fast' is the leaves tile with every transparent texel filled by the average leaf colour, a little darker. */
  _deriveTiles() {
    const src = this.tiles.get('leaves');
    const out = document.createElement('canvas'); out.width = TILE_SIZE; out.height = TILE_SIZE;
    const ctx = out.getContext('2d');
    if (src) {
      ctx.drawImage(src, 0, 0);
      const img = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE); const d = img.data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      if (n) { r = Math.round(r / n * 0.8); g = Math.round(g / n * 0.8); b = Math.round(b / n * 0.8); }
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] < 128) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
      ctx.putImageData(img, 0, 0);
    }
    this.tiles.set('leaves_fast', out);
  }

  _compose() {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    TEXTURE_NAMES.forEach((name, i) => {
      ctx.drawImage(this.getTile(name), tileColumn(i) * TILE_SIZE, tileRow(i) * TILE_SIZE);
    });
    this.canvas = canvas;
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.texture = tex;
  }

  getUV(name) { return getUV(name); }
  getTileIndex(name) { return getTileIndex(name); }

  /** 16×16 canvas for a texture name (falls back to the missing checker). */
  getTile(name) { return this.tiles.get(name) || this.tiles.get(MISSING_TEXTURE); }

  /** Large scaled-up copy of the atlas for the F7 / ?atlas debug view. */
  buildDebugCanvas(scale = 3) {
    const c = document.createElement('canvas');
    c.width = ATLAS_SIZE * scale;
    c.height = ATLAS_SIZE * scale;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#303030';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    for (let i = 0; i <= ATLAS_SIZE / TILE_SIZE; i++) {
      ctx.beginPath(); ctx.moveTo(i * TILE_SIZE * scale, 0); ctx.lineTo(i * TILE_SIZE * scale, c.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * TILE_SIZE * scale); ctx.lineTo(c.width, i * TILE_SIZE * scale); ctx.stroke();
    }
    return c;
  }
}
