// CloudSaveManager.js — worlds in Supabase (Update #6), replacing the IndexedDB SaveManager with the same
// public API: listWorlds / createWorld / getWorld / saveWorld / saveChunks / loadChunks / deleteWorld.
// `worlds.data` holds the player, inventory, dropped items, mobs, seedText and the rest of the world
// record; `world_chunks` holds one gzip+base64 edit diff per changed chunk (see cloud/ChunkCodec.js).
// Every method throws on failure so WorldSession can retry and warn; nothing is faked locally.

import { encodeChunk, decodeChunk } from './cloud/ChunkCodec.js';

const UPSERT_BATCH = 50;
const PAGE = 1000;
/** Columns kept in the row itself; everything else in the record lives inside `data`. */
const ROW_FIELDS = new Set(['id', 'name', 'seed', 'gameMode', 'created', 'lastPlayed']);

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
      created: row.created_at ? Date.parse(row.created_at) : Date.now(),
      lastPlayed: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
    };
  }

  /** @returns {Promise<Array<{id, name, seed, seedText, gameMode, lastPlayed}>>} newest first */
  async listWorlds() {
    const rows = check(await this.client.from('worlds').select('id, name, seed, game_mode, updated_at, data->seedText').order('updated_at', { ascending: false }), 'list worlds');
    return (rows || []).map((r) => ({ id: r.id, name: r.name, seed: Number(r.seed), seedText: r.seedText || '', gameMode: r.game_mode, lastPlayed: r.updated_at ? Date.parse(r.updated_at) : 0 }));
  }

  async createWorld({ name, seed, seedText, gameMode }) {
    const row = check(await this.client.from('worlds').insert({ name, seed, game_mode: gameMode, data: { seedText: seedText || '' } }).select('id, name, seed, game_mode, data, created_at, updated_at').single(), 'create world');
    return { ...this._record(row), player: null, inventory: null, entities: [], mobs: [], spawnedChunks: [] };
  }

  async getWorld(id) {
    const row = check(await this.client.from('worlds').select('*').eq('id', id).single(), 'load world');
    return row ? this._record(row) : null;
  }

  /** Write the world row: name, game mode and the JSON data (everything in the record but the row columns). */
  async saveWorld(record) {
    const data = {};
    for (const [k, v] of Object.entries(record)) if (!ROW_FIELDS.has(k)) data[k] = v;
    data.seedText = record.seedText || '';
    check(await this.client.from('worlds').update({ name: record.name, game_mode: record.gameMode, data }).eq('id', record.id), 'save world');
    record.lastPlayed = Date.now();
  }

  async updateGameMode(id, gameMode) {
    check(await this.client.from('worlds').update({ game_mode: gameMode }).eq('id', id), 'save game mode');
  }

  /** entries: [{ key, indices, ids }] — compressed and upserted in batches of 50 rows. */
  async saveChunks(worldId, entries) {
    if (!entries.length) return;
    const rows = [];
    for (const e of entries) rows.push({ world_id: worldId, chunk_key: e.key, data: await encodeChunk(e) });
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
