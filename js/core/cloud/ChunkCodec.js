// ChunkCodec.js — how one chunk's edit diff travels to the cloud: { indices, ids } → JSON → gzip
// (CompressionStream) → base64 text in world_chunks.data, and back. Block ids carry water levels and log
// orientation, so nothing else needs storing. Pure; works in browsers and in Node 18+.

const FORMAT = 1;

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** @param {{indices: Uint16Array|number[], ids: Uint8Array|number[]}} diff */
export async function encodeChunk(diff) {
  const json = JSON.stringify({ v: FORMAT, i: Array.from(diff.indices), b: Array.from(diff.ids) });
  const gz = await pipe(new TextEncoder().encode(json), new CompressionStream('gzip'));
  return bytesToBase64(gz);
}

/** @returns {Promise<{indices: Uint16Array, ids: Uint8Array}>} */
export async function decodeChunk(text) {
  const raw = await pipe(base64ToBytes(text), new DecompressionStream('gzip'));
  const obj = JSON.parse(new TextDecoder().decode(raw));
  if (!obj || obj.v !== FORMAT || !Array.isArray(obj.i) || !Array.isArray(obj.b) || obj.i.length !== obj.b.length) throw new Error('ChunkCodec: bad chunk data');
  return { indices: Uint16Array.from(obj.i), ids: Uint8Array.from(obj.b) };
}
