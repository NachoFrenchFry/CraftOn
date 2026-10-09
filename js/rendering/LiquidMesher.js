// LiquidMesher.js — water faces with Minecraft-style sloped surfaces: each top corner height is the
// weighted average of the water blocks (and air) around that corner, sides follow the corners, and the
// material is double-sided so the surface is visible from below. Pure, worker-safe.

import { PADDED_SIZE, PADDED_STRIDE_Y, WORLD_HEIGHT, FACE_BRIGHTNESS } from '../config/Constants.js';
import { OPAQUE, SOLID, FACE_TILE } from '../blocks/BlockRegistry.js';
import { TILE_UVS } from './AtlasLayout.js';
import { Direction } from '../utils/Direction.js';
import { CORNER_POS, CORNER_UV, NB_OFF } from './FaceTables.js';
import { isWater, isSource, isFalling, heightOf, isLava, isLavaSource, isLavaFalling } from '../world/WaterLevels.js';

const cornerHeights = new Float32Array(4);
/** The liquid being meshed (water or lava, Update #11): predicates for "same liquid" and "full height" blocks. */
let same = isWater, full = (id) => isSource(id) || isFalling(id);
const lavaFull = (id) => isLavaSource(id) || isLavaFalling(id);
const waterFull = (id) => isSource(id) || isFalling(id);

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
      if (y + 1 < WORLD_HEIGHT && same(padded[i + PADDED_STRIDE_Y])) return 1;
      const id = padded[i];
      if (same(id)) {
        const w = full(id) ? 10 : 1;
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

function addQuad(pb, x, ly, z, f, tile, heights, bright, light = 240, blockLight = 0, flags = 32) {
  const t4 = tile * 4;
  const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
  const corners = CORNER_POS[f];
  for (let c = 0; c < 4; c++) {
    const cp = corners[c];
    const uv = CORNER_UV[c];
    const h = cp[1] ? heights[cornerSlot(cp[0], cp[2])] : 0;
    pb.vertex(x + cp[0], ly + h, z + cp[2], uv[0] ? u1 : u0, uv[1] ? v1 : v0, bright, f | flags | (3 << 6), light, blockLight); // water flag (32) for the shader pipeline; lava has none
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
export function meshLiquid(pb, padded, idx, x, ly, z, y, id, light = null) {
  const lava = isLava(id);
  if (lava) { same = isLava; full = lavaFull; } else { same = isWater; full = waterFull; }
  const tile = FACE_TILE[id * 6 + Direction.UP];
  const above = y + 1 < WORLD_HEIGHT ? padded[idx + PADDED_STRIDE_Y] : 0;
  const fullAbove = same(above);
  for (let cz = 0; cz <= 1; cz++) for (let cx = 0; cx <= 1; cx++) {
    cornerHeights[cornerSlot(cx, cz)] = fullAbove ? 1 : cornerHeight(padded, idx, y, cx, cz);
  }
  for (let f = 0; f < 6; f++) {
    const nb = f === Direction.DOWN && y === 0 ? 0 : f === Direction.UP ? above : padded[idx + NB_OFF[f]];
    // The top surface is drawn unless more of the liquid sits above it — under a solid block it keeps its lowered
    // height, so a block placed over water never leaves a see-through hole.
    if (f === Direction.UP ? same(nb) : (same(nb) || OPAQUE[nb] === 1)) continue;
    if (lava) { addQuad(pb, x, ly, z, f, tile, cornerHeights, 1, 240, 240, 0); continue; } // lava glows: full bright, no light curve, no water flag
    const cell = light ? (OPAQUE[padded[idx + NB_OFF[f]]] === 1 ? light[idx] : light[idx + NB_OFF[f]]) : 0;
    addQuad(pb, x, ly, z, f, tile, cornerHeights, FACE_BRIGHTNESS[f], light ? (cell & 15) * 16 : 240, light ? (cell >> 4) * 16 : 0);
  }
}
