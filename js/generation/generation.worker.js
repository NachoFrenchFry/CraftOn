// generation.worker.js — worker entry: {type:'init', seed} then {type:'generate', id, cx, cz}
// → {id, cx, cz, blocks, heightMap, biomeMap, springs} with transferred buffers. Never imports Three.js.

import { WorldGenerator } from './WorldGenerator.js';

let generator = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    generator = new WorldGenerator(msg.seed);
    return;
  }
  if (msg.type === 'generate') {
    if (!generator) generator = new WorldGenerator(msg.seed || 0);
    const t0 = performance.now();
    const r = generator.generateChunk(msg.cx, msg.cz);
    self.postMessage(
      { id: msg.id, cx: msg.cx, cz: msg.cz, blocks: r.blocks, heightMap: r.heightMap, biomeMap: r.biomeMap, springs: r.springs, ms: performance.now() - t0 },
      [r.blocks.buffer, r.heightMap.buffer, r.biomeMap.buffer, r.springs.buffer],
    );
  }
};
