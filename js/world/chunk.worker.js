// chunk.worker.js — the one chunk worker: terrain generation, the initial light pass and meshing in a single
// script, so ChunkManager runs one pool of up to hardwareConcurrency − 1 workers (at most 6) and hands every job to the
// idlest worker instead of splitting cores between fixed generation and meshing pools. Never imports Three.js.
//   {type:'init', seed?, cutoutBlocks?}
//   {type:'generate', id, cx, cz, seed}            → {id, cx, cz, blocks, heightMap, biomeMap, springs, containers, ms} (buffers transferred)
// The structure files (structures/index.json → structures/<name>.json, loot.json) are fetched and parsed once at startup;
// generate jobs wait for them.
//   {type:'light', id, cx, cz, grid[9], tops[9]}   → {id, cx, cz, version, light, ms, phases}
//   {type:'mesh', id, cx, cz, padded, light, sectionMask, ao, fastLeaves, mode, timing?} → {id, cx, cz, revision, sectionMask, sections, ms, padded, light, sectionMs?}
//     (the padded / light copies travel back for reuse; every section pass is { data, yf, vertexCount } in pooled buffers)
//   {type:'recycle', buffers}  the main thread returns mesh result buffers (transferred) to this worker's pool
//   {type:'locate', id, kind, name, x, z, seed, maxDist} → {id, found: {x, y, z, distance} | null, ms}  (/locate: no chunks generated)
// Every job handler runs inside try / catch: a throw answers { id, error: { message, stack } }, so the main thread's
// promise rejects (WorkerPool) and the owner retries instead of waiting forever. Test hooks: {type:'init', debugFail:
// { type, cx?, cz?, times } | { type, crash: true } | null} makes a matching job throw `times` times (or crash the whole
// worker on it); {type:'crash'} throws outside the handler (an uncaught error: the pool's onerror replaces the worker).

import { WorldGenerator } from '../generation/WorldGenerator.js';
import { StructureRegistry } from '../generation/StructureRegistry.js';
import { locate } from '../generation/Locate.js';
import { computeChunkLight, lastPhases } from './lighting/SkyLight.js';
import { meshChunk, MeshBuilders } from '../rendering/ChunkMesher.js';
import { markCutout } from '../blocks/BlockRegistry.js';
import { BufferPool } from '../utils/ArrayPool.js';

let generator = null;
/** Linear RGB bytes per block id (3 per block), sent by the main thread from the texture files. */
/** The structure registry once loaded (null when the files are missing: the world generates without structures). */
let structures = null, structuresLoaded = false;
const structuresReady = (async () => {
  try {
    const base = new URL('../../structures/', import.meta.url);
    const index = await (await fetch(new URL('index.json', base))).json();
    const names = Array.isArray(index.structures) ? index.structures : [];
    const files = await Promise.all(names.map((f) => fetch(new URL(f, base)).then((r) => { if (!r.ok) throw new Error(f + ': ' + r.status); return r.json(); })));
    const loot = await (await fetch(new URL('loot.json', base))).json();
    structures = StructureRegistry.fromList(files, loot);
  } catch (e) { console.warn('chunk.worker: structures not loaded, generating without them', e); structures = null; }
  structuresLoaded = true;
  if (generator) generator.setStructures(structures);
})();
const newGenerator = (seed) => { const g = new WorldGenerator(seed); g.setStructures(structures); return g; };
const builders = new MeshBuilders();
/** Mesh result buffers by size class: the main thread sends them back once uploaded, so steady-state meshing allocates nothing. */
const pool = new BufferPool(24 << 20);

/** Test hook (see the header): a forced failure or crash of matching jobs. */
let debugFail = null;
function maybeFail(msg) {
  if (!debugFail || debugFail.type !== msg.type) return;
  const x = msg.cx, z = msg.cz;
  if (debugFail.cx !== undefined && (debugFail.cx !== x || debugFail.cz !== z)) return;
  if (debugFail.crash) { debugFail = null; setTimeout(() => { throw new Error(`debug: forced crash during ${msg.type} ${x},${z}`); }, 0); return; }
  if (debugFail.times > 0) { debugFail.times--; throw new Error(`debug: forced failure of ${msg.type} ${x},${z} (${debugFail.times} more to come)`); }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg && msg.type === 'crash') throw new Error('debug: forced crash'); // outside the guard: an uncaught worker error
  try { handle(e); }
  catch (err) {
    if (msg && msg.id !== undefined) self.postMessage({ id: msg.id, error: { message: String(err && err.message || err), stack: String(err && err.stack || '') } });
    else console.error('chunk.worker:', err);
  }
};

function handle(e) {
  const msg = e.data;
  if (msg.type === 'init') {
    if (msg.seed !== undefined) generator = newGenerator(msg.seed);
    if (msg.cutoutBlocks) for (const id of msg.cutoutBlocks) markCutout(id); // the atlas' transparency overrides, mirrored here
    if (msg.debugFail !== undefined) debugFail = msg.debugFail;
    return;
  }
  if (msg.type === 'generate') {
    if (!structuresLoaded) { structuresReady.then(() => self.onmessage(e)); return; } // the structure files are still loading
    maybeFail(msg);
    if (!generator || generator.seed !== msg.seed) generator = newGenerator(msg.seed || 0);
    const t0 = performance.now();
    const r = generator.generateChunk(msg.cx, msg.cz);
    self.postMessage(
      { id: msg.id, cx: msg.cx, cz: msg.cz, blocks: r.blocks, heightMap: r.heightMap, biomeMap: r.biomeMap, springs: r.springs, containers: r.containers || null, ms: performance.now() - t0 },
      [r.blocks.buffer, r.heightMap.buffer, r.biomeMap.buffer, r.springs.buffer],
    );
    return;
  }
  if (msg.type === 'locate') {
    if (!structuresLoaded) { structuresReady.then(() => self.onmessage(e)); return; }
    if (!generator || generator.seed !== msg.seed) generator = newGenerator(msg.seed || 0);
    const t0 = performance.now();
    let found = null;
    try { found = locate(generator, msg.kind, msg.name, msg.x | 0, msg.z | 0, msg.maxDist); } catch (err) { console.warn('chunk.worker: locate failed', err); }
    self.postMessage({ id: msg.id, found, ms: performance.now() - t0 });
    return;
  }
  if (msg.type === 'light') {
    maybeFail(msg);
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
    maybeFail(msg);
    const t0 = performance.now();
    const sectionMs = msg.timing ? [] : null;
    const result = meshChunk(msg.padded, msg.sectionMask, msg.ao, builders, !!msg.fastLeaves, msg.light || null, msg.mode || 'greedy', pool, sectionMs);
    const transfer = result.transfer;
    transfer.push(msg.padded.buffer);
    if (msg.light) transfer.push(msg.light.buffer);
    self.postMessage({ id: msg.id, cx: msg.cx, cz: msg.cz, revision: msg.revision, sectionMask: msg.sectionMask, sections: result.sections, ms: performance.now() - t0, padded: msg.padded, light: msg.light || null, sectionMs }, transfer);
  }
}
