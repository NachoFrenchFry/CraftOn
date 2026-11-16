// CloudSaveManager.js — worlds in Supabase, replacing the IndexedDB SaveManager with the same
// public API: listWorlds / createWorld / getWorld / saveWorld / saveChunks / loadChunks / deleteWorld.
// `worlds.data` holds the player, inventory, dropped items, mobs, seedText and the rest of the world
// record; `world_chunks` holds one gzip+base64 edit diff per changed chunk (see cloud/ChunkCodec.js).
// Every method throws on failure so WorldSession can retry and warn; nothing is faked locally.

import { encodeChunk, decodeChunk } from './cloud/ChunkCodec.js';
import { WORLD_DATA_KEYS, WORLD_DEFAULTS } from './WorldSettings.js';
import { worldTypeOf, normalizeFlatLayers } from '../generation/Superflat.js';

/** The codec worker: chunk diffs are JSON-encoded, gzipped and base64-encoded off the main thread. */
let codecWorker = null, codecId = 0;
const codecPending = new Map();
function encodeOnMainThread(entries) { return Promise.all(entries.map(async (e) => ({ key: e.key, data: await encodeChunk(e) }))); }
export function encodeChunks(entries) {
  if (typeof Worker === 'undefined') return encodeOnMainThread(entries);
  if (!codecWorker) {
    try {
      codecWorker = new Worker(new URL('./cloud/codec.worker.js', import.meta.url), { type: 'module' });
      codecWorker.onmessage = (ev) => { const p = codecPending.get(ev.data.id); if (!p) return; codecPending.delete(ev.data.id); if (ev.data.error) p.reject(new Error(ev.data.error)); else p.resolve(ev.data.rows); };
      codecWorker.onerror = (ev) => { console.warn('CloudSaveManager: codec worker failed, encoding on the main thread', ev.message || ev); for (const p of codecPending.values()) p.reject(new Error('codec worker failed')); codecPending.clear(); codecWorker = null; };
    } catch (e) { codecWorker = null; return encodeOnMainThread(entries); }
  }
  const id = ++codecId;
  const copies = entries.map((e) => ({ key: e.key, indices: Uint16Array.from(e.indices), ids: Uint8Array.from(e.ids), containers: e.containers || undefined, generated: e.generated || undefined })); // the chest contents and the generated-loot flag travel with the diff
  return new Promise((resolve, reject) => {
    codecPending.set(id, { resolve, reject });
    try { codecWorker.postMessage({ id, entries: copies }, copies.flatMap((c) => [c.indices.buffer, c.ids.buffer])); }
    catch (e) { codecPending.delete(id); reject(e); }
  }).catch(() => encodeOnMainThread(entries));
}

const UPSERT_BATCH = 50;
const PAGE = 1000;
/** Columns kept in the row itself; everything else in the record lives inside `data`. */
const ROW_FIELDS = new Set(['id', 'name', 'seed', 'gameMode', 'created', 'lastPlayed', 'survivalOnly', 'modeLocked']); // survival_only / mode_locked are columns (world_lock_and_survival_badge.sql), never in data

function check(res, what) {
  if (res && res.error) { const e = new Error(`${what}: ${res.error.message || res.error}`); e.cause = res.error; e.status = res.error.status; throw e; }
  return res ? res.data : null;
}

export class CloudSaveManager {
  /** @param {object} client supabase-js client or MockSupabase */
  constructor(client) {
    this.client = client;
    this.available = true;
  }

  open() { return Promise.resolve(); }

  _record(row) {
    const data = row.data || {};
    return {
      ...data,
      id: row.id,
      name: row.name,
      seed: Number(row.seed),
      seedText: data.seedText || '',
      gameMode: row.game_mode || data.gameMode || 'survival',
      survivalOnly: row.survival_only === true, // the Pure Survival badge: the database only ever lets it go from true to false
      modeLocked: row.mode_locked === true,     // the game mode lock: chosen at creation, never changes
      created: row.created_at ? Date.parse(row.created_at) : Date.now(),
      lastPlayed: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
    };
  }

  /** @returns {Promise<Array<{id, name, seed, seedText, gameMode, lastPlayed}>>} newest first */
  async listWorlds() {
    const rows = check(await this.client.from('worlds').select('id, name, seed, game_mode, survival_only, mode_locked, updated_at, data->seedText').order('updated_at', { ascending: false }), 'list worlds');
    return (rows || []).map((r) => ({ id: r.id, name: r.name, seed: Number(r.seed), seedText: r.seedText || '', gameMode: r.game_mode, survivalOnly: r.survival_only === true, modeLocked: r.mode_locked === true, lastPlayed: r.updated_at ? Date.parse(r.updated_at) : 0 }));
  }

  /**
   * Create a world from the Create World form's values: the name, seed and the player's game mode are row columns; every
   * other world setting (WORLD_DATA_KEYS — world type, Superflat layers, the mode for other players, fall damage, natural
   * spawning, hostile mobs, keep inventory, PvP, explosives, Same Wi-Fi multiplayer…) goes into `data`, a missing one at its
   * default. The layers are kept (normalised) only for a Superflat world. `modeLocked` is the game mode lock (a column the
   * database never lets change again); the Pure Survival badge is set by the database itself (a world created in Survival
   * has it) — the game only ever writes it off, which it does right away when the mode for other players is not Survival.
   */
  async createWorld({ name, seed, seedText, gameMode, modeLocked = false, ...settings }) {
    const data = { seedText: seedText || '' };
    for (const key of WORLD_DATA_KEYS) data[key] = settings[key] === undefined || settings[key] === null ? WORLD_DEFAULTS[key] : settings[key];
    data.structuresAvoidRavines = true; // every new world (Nov 15 2026): structures never on a ravine; the default for a world without the key stays false, so saved worlds keep theirs
    data.worldType = worldTypeOf(data.worldType);
    if (data.worldType === 'superflat') data.flatLayers = normalizeFlatLayers(data.flatLayers).layers; else delete data.flatLayers;
    const row = check(await this.client.from('worlds').insert({ name, seed, game_mode: gameMode || 'survival', mode_locked: modeLocked === true, data }).select('id, name, seed, game_mode, survival_only, mode_locked, data, created_at, updated_at').single(), 'create world');
    const record = { ...this._record(row), player: null, inventory: null, entities: [], mobs: [], spawnedChunks: [] };
    if (record.survivalOnly && data.defaultGameMode && data.defaultGameMode !== 'survival') { await this.removeSurvivalBadge(record.id); record.survivalOnly = false; }
    return record;
  }

  /** The Pure Survival badge is lost: `survival_only: false` on the row, written before the action that loses it. Throws when the server cannot be reached. */
  async removeSurvivalBadge(id) {
    check(await this.client.from('worlds').update({ survival_only: false }).eq('id', id), 'remove the badge');
  }

  async getWorld(id) {
    const row = check(await this.client.from('worlds').select('*').eq('id', id).single(), 'load world');
    return row ? this._record(row) : null;
  }

  /** Write the world row: name, game mode, the JSON data (everything in the record but the row columns) and, once the badge is gone, `survival_only: false` (never true). */
  async saveWorld(record) {
    const data = {};
    for (const [k, v] of Object.entries(record)) if (!ROW_FIELDS.has(k)) data[k] = v;
    data.seedText = record.seedText || '';
    const patch = { name: record.name, game_mode: record.gameMode, data };
    if (record.survivalOnly === false) patch.survival_only = false;
    check(await this.client.from('worlds').update(patch).eq('id', record.id), 'save world');
    record.lastPlayed = Date.now();
  }

  async updateGameMode(id, gameMode) {
    check(await this.client.from('worlds').update({ game_mode: gameMode }).eq('id', id), 'save game mode');
  }

  /** entries: [{ key, indices, ids }] — compressed and upserted in batches of 50 rows. */
  async saveChunks(worldId, entries) {
    if (!entries.length) return;
    const encoded = await encodeChunks(entries); // compressed in the codec worker
    const rows = encoded.map((e) => ({ world_id: worldId, chunk_key: e.key, data: e.data }));
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      check(await this.client.from('world_chunks').upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: 'world_id,chunk_key' }), 'save chunks');
    }
  }

  /**
   * Every chunk diff of a world, paginated 1000 rows at a time.
   * @param {(loaded: number, total: number|null) => void} [onProgress]
   * @returns {Promise<Map<string, {indices: Uint16Array, ids: Uint8Array}>>}
   */
  async loadChunks(worldId, onProgress = null) {
    const map = new Map();
    for (let from = 0; ; from += PAGE) {
      const rows = check(await this.client.from('world_chunks').select('chunk_key, data').eq('world_id', worldId).range(from, from + PAGE - 1), 'download chunks') || [];
      for (const r of rows) {
        try { map.set(r.chunk_key, await decodeChunk(r.data)); } catch (e) { console.warn('CloudSaveManager: skipping unreadable chunk', r.chunk_key, e); }
      }
      if (onProgress) onProgress(map.size, null);
      if (rows.length < PAGE) break;
    }
    return map;
  }

  async deleteWorld(id) {
    check(await this.client.from('worlds').delete().eq('id', id), 'delete world');
  }
}
