// SkyLight.js — initial sky lighting of one chunk (Update #10), run in the meshing worker: given the blocks of
// the chunk and its eight horizontal neighbours (a 3×3 grid, 48×48×256), every column starts at 15 above its
// highest block and travels straight down with no decay through opacity-0 blocks, losing a leaf / water / ice
// block's opacity on the way and stopping at the first opaque block; then the BFS spreads it sideways and
// downward under overhangs, into cave mouths and under trees. Light travels at most 15 blocks, so the 3×3
// neighbourhood makes the centre chunk (and its one-block border) exact. The result is the chunk's padded
// 18×18×256 light array (LightStorage.js). Pure and worker-safe.
import { LIGHT_MAX, OPACITY_BARRIER, allocLight, lightIndex } from './LightStorage.js';
import { LightQueue } from './LightEngine.js';
import { LIGHT_OPACITY, LIGHT_EMISSION } from '../../blocks/BlockRegistry.js';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../config/Constants.js';

const G = CHUNK_SIZE * 3;          // 48
const G_STRIDE_Y = G * G;
const G_LENGTH = G_STRIDE_Y * WORLD_HEIGHT;
let gridLight = null;
let gridOpacity = null;
/** Block light channel of the grid (Update #11): seeded by every emitter (torches, lava) in the 3×3 neighbourhood. */
let gridBlock = null;
/** Per column: y of the first opaque block from the top (-1 = none); the column is sky-lit above it. */
const columnBlock = new Int16Array(G * G);
const queue = new LightQueue(65536);
/** Milliseconds of the last computeChunkLight call per phase (diagnostics): columns, seeds, bfs, copy; plus the seed and BFS cell counts. */
export const lastPhases = { columns: 0, seeds: 0, bfs: 0, copy: 0, seeded: 0, block: 0 };
const tnow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Access object over the 3×3 grid (grid coordinates 0..47; outside = barrier), for tests of the generic engine against the grid pass. */
export const gridAccess = {
  opacity(x, y, z) {
    if (y >= WORLD_HEIGHT) return 0;
    if (x < 0 || x >= G || z < 0 || z >= G || y < 0) return OPACITY_BARRIER;
    return gridOpacity[x + z * G + y * G_STRIDE_Y];
  },
  get(x, y, z) {
    if (y >= WORLD_HEIGHT) return LIGHT_MAX;
    if (x < 0 || x >= G || z < 0 || z >= G || y < 0) return 0;
    return gridLight[x + z * G + y * G_STRIDE_Y];
  },
  set(x, y, z, _channel, v) { gridLight[x + z * G + y * G_STRIDE_Y] = v; },
};

/** Highest non-air y + 1 of a chunk from its section counts (every row above is open sky). */
export function chunkTop(chunk) {
  for (let sy = 15; sy >= 0; sy--) if (chunk.sectionCounts[sy] > 0) return (sy + 1) * 16;
  return 0;
}

/**
 * @param {Array<Uint8Array|null>} grid nine block arrays in (dz, dx) order: [nw, n, ne, w, centre, e, sw, s, se]; null = not loaded (barrier)
 * @param {number[]|null} tops per grid entry the highest non-air y + 1 (chunkTop); rows above the highest are open sky and skipped
 * @returns {Uint8Array} the centre chunk's padded light array (sky nibble and, from the emitters in the grid, the block nibble)
 */
export function computeChunkLight(grid, tops = null) {
  if (!gridLight) { gridLight = new Uint8Array(G_LENGTH); gridOpacity = new Uint8Array(G_LENGTH); gridBlock = new Uint8Array(G_LENGTH); }
  let maxTop = WORLD_HEIGHT;
  if (tops) { maxTop = 0; for (let i = 0; i < 9; i++) if (grid[i]) maxTop = Math.max(maxTop, Math.min(WORLD_HEIGHT, tops[i] | 0)); }
  const t0 = tnow();
  const skyStart = maxTop * G_STRIDE_Y;
  gridLight.fill(0, 0, skyStart); gridLight.fill(LIGHT_MAX, skyStart);
  gridOpacity.fill(0, skyStart);
  // 1. Opacity grid (unloaded chunks are barriers) and the straight-down sky columns.
  for (let gz = 0; gz < 3; gz++) for (let gx = 0; gx < 3; gx++) {
    const blocks = grid[gz * 3 + gx];
    for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) {
      const X = gx * CHUNK_SIZE + x, Z = gz * CHUNK_SIZE + z;
      const col = X + Z * G;
      if (!blocks) { columnBlock[col] = WORLD_HEIGHT; for (let y = 0; y < WORLD_HEIGHT; y++) gridOpacity[col + y * G_STRIDE_Y] = OPACITY_BARRIER; continue; }
      const b = x + (z << 4);
      let light = LIGHT_MAX, blockY = -1;
      for (let y = maxTop - 1; y >= 0; y--) {
        const op = LIGHT_OPACITY[blocks[b + (y << 8)]];
        const i = col + y * G_STRIDE_Y;
        gridOpacity[i] = op;
        if (light > 0) { if (op >= LIGHT_MAX) { light = 0; blockY = y; } else { light = Math.max(0, light - op); gridLight[i] = light; } }
      }
      columnBlock[col] = blockY;
    }
  }
  // 2. Seed the BFS. A column is sky-lit from the top down to its first opaque block, so light only has to spread
  //    where two neighbouring columns stop at different heights: the band between the two block tops holds the
  //    overhang edges, cliff faces, cave mouths and tree shade. Scanning those bands is far cheaper than every cell.
  const t1 = tnow();
  queue.clear();
  for (let z = 0; z < G; z++) for (let x = 0; x < G; x++) {
    const col = x + z * G, ba = columnBlock[col];
    if (ba >= WORLD_HEIGHT) continue; // barrier column
    const seedBand = (ncol) => {
      const bb = columnBlock[ncol];
      if (bb >= WORLD_HEIGHT || bb <= ba) return; // the neighbour is a barrier or stops lower: it is at least as lit here
      const top = Math.min(bb, maxTop - 1);
      for (let y = ba + 1; y <= top; y++) {
        const i = col + y * G_STRIDE_Y, cur = gridLight[i];
        if (cur <= 1) continue;
        const ni = ncol + y * G_STRIDE_Y;
        if (gridOpacity[ni] < LIGHT_MAX && gridLight[ni] < cur - 1) queue.push(x, y, z, cur);
      }
    };
    if (x > 0) seedBand(col - 1);
    if (x < G - 1) seedBand(col + 1);
    if (z > 0) seedBand(col - G);
    if (z < G - 1) seedBand(col + G);
  }
  const t2 = tnow(); lastPhases.seeded = queue.length;
  propagateGrid(gridLight, true);
  const t3 = tnow();
  // 3. Block light (Update #11): every emitter in the grid (torches 14, lava 15) seeds the BLOCK channel; the same BFS
  //    without the sky-column rule. Emitters sit below the tops, so only those rows are scanned.
  gridBlock.fill(0);
  queue.clear();
  let emitters = 0;
  for (let gz = 0; gz < 3; gz++) for (let gx = 0; gx < 3; gx++) {
    const blocks = grid[gz * 3 + gx];
    if (!blocks) continue;
    const top = tops ? Math.min(WORLD_HEIGHT, tops[gz * 3 + gx] | 0) : maxTop;
    for (let y = 0; y < top; y++) {
      const yb = y << 8, gy = y * G_STRIDE_Y;
      for (let b = 0; b < 256; b++) {
        const e = LIGHT_EMISSION[blocks[yb + b]];
        if (e === 0) continue;
        const X = gx * CHUNK_SIZE + (b & 15), Z = gz * CHUNK_SIZE + (b >> 4);
        gridBlock[X + Z * G + gy] = e; queue.push(X, y, Z, e); emitters++;
      }
    }
  }
  if (emitters > 0) propagateGrid(gridBlock, false);
  const t4 = tnow();
  // 4. Copy the centre chunk plus its one-block border into the padded light array (sky low nibble, block high nibble).
  const out = allocLight();
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const yBase = y * G_STRIDE_Y;
    for (let lz = -1; lz <= CHUNK_SIZE; lz++) {
      const src = yBase + (CHUNK_SIZE + lz) * G + CHUNK_SIZE - 1;
      const dst = lightIndex(-1, y, lz);
      if (emitters > 0) for (let lx = -1; lx <= CHUNK_SIZE; lx++) out[dst + lx + 1] = gridLight[src + lx + 1] | (gridBlock[src + lx + 1] << 4);
      else for (let lx = -1; lx <= CHUNK_SIZE; lx++) out[dst + lx + 1] = gridLight[src + lx + 1];
    }
  }
  lastPhases.columns = t1 - t0; lastPhases.seeds = t2 - t1; lastPhases.bfs = t3 - t2; lastPhases.block = t4 - t3; lastPhases.copy = tnow() - t4;
  return out;
}

const cell = [0, 0, 0, 0];
/**
 * The LightEngine propagation rule on the 48×48×256 grid with plain array indexing (the generic `propagate` with its
 * access object costs about twice as much here). Same rule: cost 1 + opacity per step, opaque / barrier cells stop it,
 * a downward step from a cell whose upward neighbour is at least as bright costs only the opacity (sky column).
 */
function propagateGrid(L, sky) {
  const O = gridOpacity;
  while (queue.shift(cell)) {
    const x = cell[0], y = cell[1], z = cell[2];
    const i = x + z * G + y * G_STRIDE_Y;
    const cur = L[i];
    if (cur <= 0) continue;
    const columnLit = sky && (y + 1 < WORLD_HEIGHT ? L[i + G_STRIDE_Y] : LIGHT_MAX) >= cur;
    let ni, op, nl;
    if (x > 0) { ni = i - 1; op = O[ni]; if (op < LIGHT_MAX) { nl = cur - 1 - op; if (nl > L[ni]) { L[ni] = nl; queue.push(x - 1, y, z, nl); } } }
    if (x < G - 1) { ni = i + 1; op = O[ni]; if (op < LIGHT_MAX) { nl = cur - 1 - op; if (nl > L[ni]) { L[ni] = nl; queue.push(x + 1, y, z, nl); } } }
    if (z > 0) { ni = i - G; op = O[ni]; if (op < LIGHT_MAX) { nl = cur - 1 - op; if (nl > L[ni]) { L[ni] = nl; queue.push(x, y, z - 1, nl); } } }
    if (z < G - 1) { ni = i + G; op = O[ni]; if (op < LIGHT_MAX) { nl = cur - 1 - op; if (nl > L[ni]) { L[ni] = nl; queue.push(x, y, z + 1, nl); } } }
    if (y + 1 < WORLD_HEIGHT) { ni = i + G_STRIDE_Y; op = O[ni]; if (op < LIGHT_MAX) { nl = cur - 1 - op; if (nl > L[ni]) { L[ni] = nl; queue.push(x, y + 1, z, nl); } } }
    if (y > 0) { ni = i - G_STRIDE_Y; op = O[ni]; if (op < LIGHT_MAX) { nl = columnLit ? cur - op : cur - 1 - op; if (nl > L[ni]) { L[ni] = nl; queue.push(x, y - 1, z, nl); } } }
  }
}

/** Light level a straight-down sky column gives at (y) given the opacities above it (helper for tests). */
export function columnLightFrom(opacities) {
  let light = LIGHT_MAX;
  const out = new Array(opacities.length);
  for (let i = 0; i < opacities.length; i++) { const op = opacities[i]; light = op >= LIGHT_MAX ? 0 : Math.max(0, light - op); out[i] = light; }
  return out;
}
