// BlockIconRenderer.js — isometric item icons drawn with 2D canvas affine transforms from the atlas
// tiles (top / left / right faces with baked brightness). Plants use their flat texture. Cached.

import { BlockRegistry, RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { Direction } from '../utils/Direction.js';

const ICON_SIZE = 48;

export class BlockIconRenderer {
  /** @param {import('./TextureAtlas.js').TextureAtlas} atlas */
  constructor(atlas) {
    this.atlas = atlas;
    this.cache = new Map();
  }

  /** Data URL of the icon for an item id (block items: isometric cube; plants and items: flat texture). */
  /** A faint single-colour silhouette of an item icon (empty armor slots). */
  getSilhouette(itemId, color = 'rgba(214, 222, 255, 0.9)') {
    const key = 's' + itemId;
    if (this.cache.has(key)) return this.cache.get(key);
    const img = new Image();
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE; canvas.height = ICON_SIZE;
    const ctx = canvas.getContext('2d');
    const item = ItemRegistry.get(itemId);
    if (item && item.texture) {
      const tile = this.atlas.getTile(item.texture);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tile, 0, 0, ICON_SIZE, ICON_SIZE);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
    }
    const url = canvas.toDataURL();
    this.cache.set(key, url);
    void img;
    return url;
  }

  getIcon(itemId) {
    let url = this.cache.get(itemId);
    if (url) return url;
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const item = ItemRegistry.get(itemId);
    if (item && !item.isBlock) this._drawFlat(ctx, item.texture);
    else if (RENDER_TYPE[itemId] === RenderType.CROSS || RENDER_TYPE[itemId] === RenderType.TORCH) this._drawFlat(ctx, BlockRegistry.faceTexture(itemId, Direction.SOUTH)); // plants and torches: the flat texture
    else this._drawCube(ctx, itemId);
    url = canvas.toDataURL();
    this.cache.set(itemId, url);
    return url;
  }

  _drawFlat(ctx, textureName) {
    const tile = this.atlas.getTile(textureName);
    const pad = 4;
    ctx.drawImage(tile, pad, pad, ICON_SIZE - pad * 2, ICON_SIZE - pad * 2);
  }

  _drawCube(ctx, blockId) {
    const S = ICON_SIZE, half = S / 2, q = S / 4;
    const top = this.atlas.getTile(BlockRegistry.faceTexture(blockId, Direction.UP));
    const left = this.atlas.getTile(BlockRegistry.faceTexture(blockId, Direction.NORTH));
    const right = this.atlas.getTile(BlockRegistry.faceTexture(blockId, Direction.EAST));
    const k = 16;
    const drawFace = (img, a, b, c, d, e, f, darken) => {
      ctx.save();
      ctx.setTransform(a, b, c, d, e, f);
      ctx.drawImage(img, 0, 0, k, k, 0, 0, k, k);
      if (darken > 0) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = `rgba(0,0,0,${darken})`;
        ctx.fillRect(0, 0, k, k);
      }
      ctx.restore();
    };
    // Isometric-ish (2:1) projection: top rhombus, left and right parallelograms.
    drawFace(left, half / k, q / k, 0, half / k, 0, q, 0.2);
    drawFace(right, half / k, -q / k, 0, half / k, half, half, 0.4);
    drawFace(top, half / k, q / k, -half / k, q / k, half, 0, 0);
  }
}
