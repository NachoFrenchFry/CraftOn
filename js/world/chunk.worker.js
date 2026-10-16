// chunk.worker.js — the one chunk worker: terrain generation, the initial light pass and meshing in a single
// script, so ChunkManager runs one pool of up to hardwareConcurrency − 1 workers (at most 6) and hands every job to the
// idlest worker instead of splitting cores between fixed generation and meshing pools. Never imports Three.js.
//   {type:'init', seed?, cutoutBlocks?}
//   {type:'generate', id, cx, cz, seed}            → {id, cx, cz, blocks, heightMap, biomeMap, springs, ms} (buffers transferred)
//   {type:'light', id, cx, cz, grid[9], tops[9]}   → {id, cx, cz, version, light, ms, phases}
//   {type:'mesh', id, cx, cz, padded, light, sectionMask, ao, fastLeaves, mode, timing?} → {id, cx, cz, revision, sectionMask, sections, ms, padded, light, sectionMs?}
//     (the padded / light copies travel back for reuse; every section pass is { data, yf, vertexCount } in pooled buffers)
//   {type:'recycle', buffers}  the main thread returns mesh result buffers (transferred) to this worker's pool

import { WorldGenerator } from '../generation/WorldGenerator.js';
import { computeChunkLight, lastPhases } from './lighting/SkyLight.js';
import { meshChunk, MeshBuilders } from '../rendering/ChunkMesher.js';
import { markCutout } from '../blocks/BlockRegistry.js';
import { BufferPool } from '../utils/ArrayPool.js';

let generator = null;
const builders = new MeshBuilders();
/** Mesh result buffers by size class: the main thread sends them back once uploaded, so steady-state meshing allocates nothing. */
const pool = new BufferPool(24 << 20);

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    if (msg.seed !== undefined) generator = new WorldGenerator(msg.seed);
    if (msg.cutoutBlocks) for (const id of msg.cutoutBlocks) markCutout(id); // the atlas' transparency overrides, mirrored here
    return;
  }
  if (msg.type === 'generate') {
    if (!generator || generator.seed !== msg.seed) generator = new WorldGenerator(msg.seed || 0);
    const t0 = performance.now();
    const r = generator.generateChunk(msg.cx, msg.cz);
    self.postMessage(
      { id: msg.id, cx: msg.cx, cz: msg.cz, blocks: r.blocks, heightMap: r.heightMap, biomeMap: r.biomeMap, springs: r.springs, ms: performance.now() - t0 },
      [r.blocks.buffer, r.heightMap.buffer, r.biomeMap.buffer, r.springs.buffer],
    );
    return;
  }
  if (msg.type === 'light') {
    const t0 = performance.now();
    const light = computeChunkLight(msg.grid, msg.tops || null);
    self.postMessage({ id: msg.id, cx: msg.cx, cz: msg.cz, revision: msg.revision, light, ms: performance.now() - t0, phases: { ...lastPhases } }, [light.buffer]);
    return;
  }
  if (msg.type === 'recycle') {
    for (const b of msg.buffers) pool.release(b);
    return;
  }
  if (msg.type === 'mesh') {
    const t0 = performance.now();
    const sectionMs = msg.timing ? [] : null;
    const result = meshChunk(msg.padded, msg.sectionMask, msg.ao, builders, !!msg.fastLeaves, msg.light || null, msg.mode || 'greedy', pool, sectionMs);
    const transfer = result.transfer;
    transfer.push(msg.padded.buffer);
    if (msg.light) transfer.push(msg.light.buffer);
    self.postMessage({ id: msg.id, cx: msg.cx, cz: msg.cz, revision: msg.revision, sectionMask: msg.sectionMask, sections: result.sections, ms: performance.now() - t0, padded: msg.padded, light: msg.light || null, sectionMs }, transfer);
  }
};
