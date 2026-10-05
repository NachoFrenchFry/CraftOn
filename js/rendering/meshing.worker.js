// meshing.worker.js — worker entry for ChunkMesher. Receives padded block arrays, returns raw buffers.
// Never imports Three.js (import maps don't apply in workers).

import { meshChunk, MeshBuilders } from './ChunkMesher.js';
import { markCutout } from '../blocks/BlockRegistry.js';

const builders = new MeshBuilders();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // Blocks whose textures turned out to have transparent pixels are meshed as cutouts here too.
    for (const id of msg.cutoutBlocks || []) markCutout(id);
    return;
  }
  if (msg.type !== 'mesh') return;
  const { id, cx, cz, padded, sectionMask, ao, version } = msg;
  const t0 = performance.now();
  const result = meshChunk(padded, sectionMask, ao, builders);
  self.postMessage({ id, cx, cz, version, sectionMask, sections: result.sections, ms: performance.now() - t0 }, result.transfer);
};
