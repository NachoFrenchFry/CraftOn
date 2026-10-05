// LiquidMesher.js — water faces with Minecraft-style sloped surfaces: each top corner height is the
// weighted average of the water blocks (and air) around that corner, sides follow the corners, and the
// material is double-sided so the surface is visible from below. Pure, worker-safe.

import { PADDED_SIZE, PADDED_STRIDE_Y, WORLD_HEIGHT, FACE_BRIGHTNESS } from '../config/Constants.js';
import { OPAQUE, SOLID, FACE_TILE } from '../blocks/BlockRegistry.js';
import { TILE_UVS } from './AtlasLayout.js';
import { Direction } from '../utils/Direction.js';
import { CORNER_POS, CORNER_UV, NB_OFF } from './FaceTables.js';
import { isWater, isSource, isFalling, heightOf } from '../world/WaterLevels.js';

const cornerHeights = new Float32Array(4);

/**
 * Height of the water surface at a top corner. `cx`, `cz` ∈ {0,1} pick the corner; the four cells around
 * it are (x+cx-1..x+cx, z+cz-1..z+cz). Any water above one of them makes the corner full height; sources
 * and falling water weigh 10, flowing water 1, air 1 (pulling the corner down); solid blocks are ignored.
 */
function cornerHeight(padded, idx, y, cx, cz) {
  let sum = 0, weight = 0;
  for (let dz = cz - 1; dz <= cz; dz++) {
    for (let dx = cx - 1; dx <= cx; dx++) {
      const i = idx + dx + dz * PADDED_SIZE;
      if (y + 1 < WORLD_HEIGHT && isWater(padded[i + PADDED_STRIDE_Y])) return 1;
      const id = padded[i];
      if (isWater(id)) {
        const w = (isSource(id) || isFalling(id)) ? 10 : 1;
        sum += heightOf(id) * w;
        weight += w;
      } else if (SOLID[id] !== 1) {
        weight += 1; // air / plants: height 0
      }
    }
  }
  return weight > 0 ? sum / weight : heightOf(padded[idx]);
}

/** Corner index in cornerHeights for a corner position (x, z) ∈ {0,1}². */
const cornerSlot = (x, z) => x + z * 2;

function addQuad(pb, x, ly, z, f, tile, heights, bright) {
  const t4 = tile * 4;
  const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
  const corners = CORNER_POS[f];
  for (let c = 0; c < 4; c++) {
    const cp = corners[c];
    const uv = CORNER_UV[c];
    const h = cp[1] ? heights[cornerSlot(cp[0], cp[2])] : 0;
    pb.vertex(x + cp[0], ly + h, z + cp[2], uv[0] ? u1 : u0, uv[1] ? v1 : v0, bright);
  }
  pb.quadIndices(false);
}

/**
 * Emit the faces of one water block.
 * @param {import('./ChunkMesher.js').PassBuilder} pb translucent pass builder
 * @param {Uint8Array} padded
 * @param {number} idx index of the block in `padded`
 * @param {number} x local x, ly section-local y, z local z, y world y
 */
export function meshLiquid(pb, padded, idx, x, ly, z, y, id) {
  const tile = FACE_TILE[id * 6 + Direction.UP];
  const above = y + 1 < WORLD_HEIGHT ? padded[idx + PADDED_STRIDE_Y] : 0;
  const fullAbove = isWater(above);
  for (let cz = 0; cz <= 1; cz++) for (let cx = 0; cx <= 1; cx++) {
    cornerHeights[cornerSlot(cx, cz)] = fullAbove ? 1 : cornerHeight(padded, idx, y, cx, cz);
  }
  for (let f = 0; f < 6; f++) {
    const nb = f === Direction.DOWN && y === 0 ? 0 : f === Direction.UP ? above : padded[idx + NB_OFF[f]];
    // The top surface is drawn unless more water sits above it — under a solid block it keeps its lowered
    // height, so a block placed over water never leaves a see-through hole.
    if (f === Direction.UP ? isWater(nb) : (isWater(nb) || OPAQUE[nb] === 1)) continue;
    addQuad(pb, x, ly, z, f, tile, cornerHeights, FACE_BRIGHTNESS[f]);
  }
}
