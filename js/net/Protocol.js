// Protocol.js — message types and encoding for LAN multiplayer (Update #8). Every gameplay message travels
// over WebRTC data channels: small JSON objects (t = type) on the ordered "reliable" channel, frequent
// snapshots as compact arrays on the unordered, no-retransmit "state" channel, and chunk edit diffs as
// gzip + base64 text (cloud/ChunkCodec.js) in batches. Pure; no DOM, no Three.js.

import { encodeChunk, decodeChunk } from '../core/cloud/ChunkCodec.js';

/** Hosts and guests must match exactly ("Different game version"). */
export const GAME_VERSION = '11';
export const MAX_PLAYERS_DEFAULT = 8;
export const MAX_PLAYERS_MIN = 2;
export const MAX_PLAYERS_MAX = 8;
export const CHUNK_BATCH = 20;
/** Rates (Hz) and delays (s). */
export const PLAYER_SNAPSHOT_HZ = 20;
export const MOB_SNAPSHOT_HZ = 12;
export const INTERP_DELAY = 0.1;
export const EXTRAPOLATE_MAX = 0.2;
export const PING_SECONDS = 2;
export const PEER_TIMEOUT_SECONDS = 6;
export const JOIN_TIMEOUT_MS = 15000;

export const Msg = Object.freeze({
  HELLO: 'hello', REJECT: 'reject', WELCOME: 'welcome', CHUNKS: 'chunks',
  BLOCK: 'block', BLOCK_REJECT: 'blockReject', MODE: 'mode', // MODE: host → guest, the guest's game mode + whether it may change it (Update #9)
  ATTACK: 'attack', MOB_HURT: 'mobHurt', MOB_SPAWN: 'mobSpawn', MOB_REMOVE: 'mobRemove',
  // Update #9 §8: HIT attacker → host (a player hit), DAMAGE host → victim (validated amount), HURT host → everyone
  // else (flash / sound), HEALTH guest → host (its health, after fall damage too), DEATH (guest → host → all), WORLD (pvp / keep inventory)
  HIT: 'hit', DAMAGE: 'damage', HURT: 'hurt', HEALTH: 'health', DEATH: 'death', WORLD: 'world',
  PICKUP: 'pickup', ITEM_GRANT: 'itemGrant', ITEM_SPAWN: 'itemSpawn', ITEM_REMOVE: 'itemRemove',
  META: 'meta', SWING: 'swing', MINING: 'mining', SOUND: 'sound',
  BLOCKS: 'blocks', THROW: 'throw',
  JOIN: 'join', LEAVE: 'leave', INV: 'inv', BYE: 'bye', HOST_CLOSED: 'hostClosed',
  PING: 'ping', PONG: 'pong',
  // state channel
  P: 'p', PS: 'ps', M: 'm',
});

export const RejectReason = Object.freeze({
  FULL: 'The server is full.',
  VERSION: 'Different game version.',
  DUPLICATE: 'That account is already in this world.',
  CLOSED: 'The host closed the server.',
});

/** Pose bits in player snapshots. */
export const Pose = Object.freeze({ ON_GROUND: 1, SNEAKING: 2, SWIMMING: 4, CRAWLING: 8, FLYING: 16, IN_WATER: 32, SPRINTING: 64, SPECTATOR: 128, ON_FIRE: 256, IN_LAVA: 512 });

/** Pose bits of a local Player. */
export function poseBits(p) {
  return (p.onGround ? Pose.ON_GROUND : 0) | (p.sneaking ? Pose.SNEAKING : 0) | (p.swimming ? Pose.SWIMMING : 0) | (p.crawling ? Pose.CRAWLING : 0)
    | (p.flying ? Pose.FLYING : 0) | (p.inWater ? Pose.IN_WATER : 0) | (p.sprinting ? Pose.SPRINTING : 0) | (p.isSpectator ? Pose.SPECTATOR : 0)
    | (p.onFire ? Pose.ON_FIRE : 0) | (p.inLava ? Pose.IN_LAVA : 0);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/** Compact snapshot array of a local player: [x, y, z, vx, vy, vz, yaw, pitch, pose]. */
export function encodePlayerState(p) {
  return [r3(p.position.x), r3(p.position.y), r3(p.position.z), r3(p.velocity.x), r3(p.velocity.y), r3(p.velocity.z), r3(p.yaw), r3(p.pitch), poseBits(p)];
}

/** Object form of a snapshot array (with the pose bits decoded). */
export function decodePlayerState(a) {
  const pose = a[8] | 0;
  return {
    x: a[0], y: a[1], z: a[2], vx: a[3], vy: a[4], vz: a[5], yaw: a[6], pitch: a[7], pose,
    onGround: !!(pose & Pose.ON_GROUND), sneaking: !!(pose & Pose.SNEAKING), swimming: !!(pose & Pose.SWIMMING), crawling: !!(pose & Pose.CRAWLING),
    flying: !!(pose & Pose.FLYING), inWater: !!(pose & Pose.IN_WATER), sprinting: !!(pose & Pose.SPRINTING), spectator: !!(pose & Pose.SPECTATOR),
    onFire: !!(pose & Pose.ON_FIRE), inLava: !!(pose & Pose.IN_LAVA),
  };
}

export function encode(msg) { return JSON.stringify(msg); }
export function decode(text) { try { return JSON.parse(text); } catch (e) { return null; } }

/** Chunk diffs → [{ key, data }] rows (gzip + base64) in batches of CHUNK_BATCH. */
export async function encodeChunkBatches(edits) {
  const rows = [];
  for (const key of edits.chunks.keys()) {
    const diff = edits.serializeChunk(key);
    if (diff && diff.indices.length) rows.push({ key, data: await encodeChunk(diff) });
  }
  const batches = [];
  for (let i = 0; i < rows.length; i += CHUNK_BATCH) batches.push(rows.slice(i, i + CHUNK_BATCH));
  if (!batches.length) batches.push([]);
  return { batches, count: rows.length };
}

export async function decodeChunkRow(row) { return { key: row.key, diff: await decodeChunk(row.data) }; }

/** Six-character join code (A–Z and digits, no ambiguous 0/O/1/I). */
export function makeJoinCode(rng = Math.random) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}
export const JOIN_CODE_PATTERN = /^[A-Z0-9]{6}$/;
