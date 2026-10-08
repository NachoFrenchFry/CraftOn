// meshing.worker.js — worker entry for ChunkMesher. Receives padded block arrays, returns raw buffers.
// Never imports Three.js (import maps don't apply in workers).

import { meshChunk, MeshBuilders } from './ChunkMesher.js';
import { markCutout } from '../blocks/BlockRegistry.js';
import { computeChunkLight, lastPhases } from '../world/lighting/SkyLight.js';

const builders = new MeshBuilders();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // Blocks whose textures turned out to have transparent pixels are meshed as cutouts here too.
    for (const id of msg.cutoutBlocks || []) markCutout(id);
    return;
  }
  if (msg.type === 'light') {
    // Initial sky light of one chunk from its 3×3 block neighbourhood (Update #10); the padded light array goes back transferred.
    const t0 = performance.now();
    const light = computeChunkLight(msg.grid, msg.tops || null);
    self.postMessage({ id: msg.id, cx: msg.cx, cz: msg.cz, version: msg.version, light, ms: performance.now() - t0, phases: { ...lastPhases } }, [light.buffer]);
    return;
  }
  if (msg.type !== 'mesh') return;
  const { id, cx, cz, padded, light, sectionMask, ao, fastLeaves, version } = msg;
  const t0 = performance.now();
  const result = meshChunk(padded, sectionMask, ao, builders, !!fastLeaves, light || null);
  self.postMessage({ id, cx, cz, version, sectionMask, sections: result.sections, ms: performance.now() - t0 }, result.transfer);
};
