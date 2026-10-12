// codec.worker.js — compresses chunk edit diffs for the cloud off the main thread (Update #14 §3): an autosave with many
// dirty chunks used to JSON-encode, gzip and base64 every chunk on the game thread. {id, entries: [{key, indices, ids}]}
// → {id, rows: [{key, data}]}.
import { encodeChunk } from './ChunkCodec.js';

self.onmessage = async (e) => {
  const { id, entries } = e.data;
  const rows = [];
  try {
    for (const en of entries) rows.push({ key: en.key, data: await encodeChunk(en) });
    self.postMessage({ id, rows });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
