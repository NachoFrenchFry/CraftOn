// WorldSession.js — world lifecycle on top of the cloud save manager (Update #6): download the world row
// and its chunk diffs (with progress), find spawn, stream the spawn area, autosave every 60 s with retry
// and backoff on failure, "Saving…" on Save & Quit, one open tab per world, and the unsaved-changes
// answer for the browser's leave-page prompt. Owned by Game.

import { State } from './GameState.js';
import { WorldGenerator } from '../generation/WorldGenerator.js';
import { BiomeIds } from '../generation/Biomes.js';
import { findSpawnColumn } from '../generation/SpawnFinder.js';
import { SEA_LEVEL, PLAYER_HEIGHT } from '../config/Constants.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { SOLID } from '../blocks/BlockRegistry.js';
import { GameMode } from '../player/Player.js';
import { WorldLock } from './cloud/WorldLock.js';
import { decodeChunkRow } from '../net/Protocol.js';

const AUTOSAVE_SECONDS = 60;
const LOAD_TIMEOUT_MS = 60000;
const RETRY_SECONDS = [5, 10, 20, 40, 60];
const QUIT_RETRY_MS = [1000, 2000, 4000];

// New Survival worlds start with an empty inventory (Update #2).

export class WorldSession {
  /** @param {import('./Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.meta = null;
    this.autosaveTimer = AUTOSAVE_SECONDS;
    this.loading = false;
    this.saving = false;
    this.lock = null;
    /** True after a failed save until one succeeds (the dirty chunks are kept). */
    this.lastSaveFailed = false;
    this.retryIndex = 0;
    /** Anything changed since the last successful save (player state, inventory, blocks)? */
    this.changedSinceSave = false;
    /** "cx,cz" keys of chunks whose first-generation mob spawn already happened (saved with the world). */
    this.spawnedChunks = new Set();
    game.events.on('block:changed', (x, y, z, info) => { if (!info || info.recorded !== false) this.changedSinceSave = true; });
    game.events.on('inventory:changed', () => { this.changedSinceSave = true; });
  }

  get inWorld() { return !!this.meta; }
  /** A guest of a LAN server: the host holds the save. */
  get remote() { return !!(this.meta && this.meta.remote); }

  /** For the beforeunload prompt: unsaved edits, or a save that has not gone through yet. */
  hasUnsavedChanges() {
    if (!this.meta || this.meta.remote) return false;
    return this.game.world.edits.dirtyKeys.size > 0 || this.lastSaveFailed || this.changedSinceSave || this.saving;
  }

  /** Download a saved world by id (fresh worlds have no player yet) and enter it. */
  async start(worldId) {
    const g = this.game;
    if (this.loading) return false;
    const lock = new WorldLock(worldId);
    if (!lock.acquire()) { g.ui.mainMenu.showWorlds(); g.ui.mainMenu.showError('This world is already open in another tab.'); return false; }
    this.loading = true;
    // The loading screen appears with the state change — before the first network request.
    g.state.set(State.LOADING);
    g.ui.loading.show('Downloading world…');
    const T = g.timing;
    T.phases = T.phases.filter((p) => p.group !== 'play');
    const rowPhase = T.start('world row', 'play');
    let meta, edits, chunkPhase = null;
    try {
      meta = await g.saveManager.getWorld(worldId);
      if (!meta) throw new Error('world not found');
      T.end(rowPhase);
      chunkPhase = T.start('chunk download + decode', 'play');
      let count = 0;
      edits = await g.saveManager.loadChunks(meta.id, (loaded) => { count = loaded; g.ui.loading.setProgress(Math.min(0.9, loaded / (loaded + 40))); g.ui.loading.setText(`${loaded} chunk${loaded === 1 ? '' : 's'}`); });
      g.ui.loading.setText(`${count} chunk${count === 1 ? '' : 's'}`);
      T.end(chunkPhase, `${count} chunks`);
    } catch (e) {
      console.warn('WorldSession: download failed', e);
      lock.release();
      this.loading = false;
      g.state.set(State.MENU);
      g.ui.mainMenu.showWorlds();
      g.ui.mainMenu.showError("Couldn't download the world. Check your connection.");
      return false;
    }
    this.lock = lock;
    this.meta = meta;
    meta.guests = meta.guests && typeof meta.guests === 'object' ? meta.guests : {}; // LAN guests' player data (Update #8)
    g.worldMeta = meta;
    if (g.sessionGuard) g.sessionGuard.claim(); // entering a world claims the account again
    g.ui.loading.show('Generating terrain…');
    const genPhase = T.start('spawn generation', 'play');

    // Reset world state.
    g.chunkManager.clear();
    g.world.clear();
    g.entities.clear();
    g.waterSim.clear();
    g.world.seed = meta.seed >>> 0;
    g.chunkManager.setSeed(g.world.seed);
    for (const [key, data] of edits) g.world.edits.loadChunk(key, data);
    // Mobs must be registered before chunks stream in, so they reappear when their chunk loads.
    this.spawnedChunks = new Set(Array.isArray(meta.spawnedChunks) ? meta.spawnedChunks : []);
    if (g.entities.mobs) g.entities.mobs.deserialize(meta.mobs);

    // Player, inventory and mode.
    const p = g.player;
    p.gameMode = Object.values(GameMode).includes(meta.gameMode) ? meta.gameMode : GameMode.SURVIVAL;
    p.spectatorSpeed = 1;
    p.flying = false;
    p.sneaking = false;
    g.cameraController.perspective = 0;
    g.inventory.clear();
    p.dead = false; p.health = p.maxHealth; g.health.reset();
    if (meta.player) {
      p.deserialize(meta.player);
      g.inventory.deserialize(meta.inventory);
      if (meta.perspective) g.cameraController.perspective = meta.perspective;
    } else {
      const spawnPhase = T.start('spawn column search', 'play');
      const spawn = this._findSpawn(g.world.seed);
      T.end(spawnPhase);
      p.spawn.set(spawn.x, spawn.y, spawn.z);
      p.teleport(spawn.x, spawn.y, spawn.z);
      p.yaw = 0; p.pitch = 0;
    }

    await this._streamSpawnArea();
    g.ui.loading.show('Almost ready…', { keepProgress: true });
    g.ui.loading.setProgress(1);
    if (!meta.player) this._settleOnSurface();
    else this._settleIfBuried();
    g.entities.deserialize(meta.entities);
    T.end(genPhase, `${g.world.chunks.size} chunks loaded`);
    if (g.debuglog) T.report('play');
    this.autosaveTimer = AUTOSAVE_SECONDS;
    this.lastSaveFailed = false;
    this.retryIndex = 0;
    this.changedSinceSave = false; // a fresh spawn alone never triggers the leave-page prompt
    this.loading = false;
    g.state.set(State.PLAYING);
    g.loop.resetTiming();
    g.requestPointerLock();
    return true;
  }

  /**
   * Join a LAN server as a guest (Update #8): the host's WELCOME gives the seed, world name, game mode, the
   * saved player data for this account (or the world spawn), the mobs, items and players; the chunk edit diffs
   * stream in afterwards ("Downloading world…"), then the terrain generates locally from the seed
   * ("Generating terrain…"). Nothing is saved to the cloud: the host keeps this player's data.
   */
  async startRemote(client, w) {
    const g = this.game;
    if (this.loading) return false;
    this.loading = true;
    g.state.set(State.LOADING);
    g.ui.loading.show('Downloading world…');
    client.onProgress = (n, total) => { g.ui.loading.setProgress(total ? Math.min(0.9, n / Math.max(1, total)) : 0.5); g.ui.loading.setText(`${n} of ${total ?? '?'} chunk${total === 1 ? '' : 's'}`); };
    const rows = await client.chunks();
    if (!rows || client.closed) {
      this.loading = false;
      g.net = null;
      g.state.set(State.MENU);
      g.ui.multiplayer.showFind('The host closed the server.');
      return false;
    }
    if (g.sessionGuard) g.sessionGuard.claim();
    const meta = { id: null, remote: true, name: w.worldName, seed: w.seed >>> 0, seedText: '', gameMode: w.gameMode, hostName: w.hostName, player: w.you ? w.you.player : null, inventory: w.you ? w.you.inventory : null, spawnedChunks: [], entities: [], mobs: [], guests: {} };
    this.meta = meta;
    g.worldMeta = meta;
    g.ui.loading.show('Generating terrain…');
    g.chunkManager.clear();
    g.world.clear();
    g.entities.clear();
    g.waterSim.clear();
    g.world.seed = meta.seed;
    g.chunkManager.setSeed(g.world.seed);
    for (const row of rows) {
      try { const { key, diff } = await decodeChunkRow(row); g.world.edits.loadChunk(key, diff); } catch (e) { console.warn('WorldSession: bad chunk row from the host', row && row.key, e); }
    }
    g.world.edits.dirtyKeys.clear();
    g.entities.remote = true;
    g.entities.mobs.remote = true;
    g.entities.mobs.deserializeRemote(w.mobs);
    for (const it of w.items || []) g.entities.spawnItem(it.x, it.y, it.z, it.item, it.n, it.vx, it.vy, it.vz, 0.25, it.id);
    const now = performance.now() / 1000;
    for (const p of w.players || []) { const rp = g.remotePlayers.add(p.id, p.name); rp.setMeta(p); if (p.state) rp.snapshot(now, p.state); }
    const p = g.player;
    p.dead = false; p.health = p.maxHealth; g.health.reset();
    p.gameMode = Object.values(GameMode).includes(meta.gameMode) ? meta.gameMode : GameMode.SURVIVAL;
    p.spectatorSpeed = 1;
    p.flying = false;
    p.sneaking = false;
    g.cameraController.perspective = 0;
    g.inventory.clear();
    if (meta.player) {
      p.deserialize(meta.player);
      g.inventory.deserialize(meta.inventory);
    } else {
      const s = w.spawn || { x: 0.5, y: 80, z: 0.5 };
      p.spawn.set(s.x, s.y, s.z);
      p.teleport(s.x, s.y, s.z);
      p.yaw = 0; p.pitch = 0;
    }
    await this._streamSpawnArea();
    if (client.closed) { this.loading = false; this._leave(); g.net = null; g.state.set(State.MENU); g.ui.multiplayer.showFind('The host closed the server.'); return false; }
    g.ui.loading.show('Almost ready…', { keepProgress: true });
    g.ui.loading.setProgress(1);
    if (!meta.player) this._settleOnSurface(); else this._settleIfBuried();
    this.autosaveTimer = AUTOSAVE_SECONDS;
    this.lastSaveFailed = false;
    this.retryIndex = 0;
    this.changedSinceSave = false;
    this.loading = false;
    g.state.set(State.PLAYING);
    g.loop.resetTiming();
    g.requestPointerLock();
    client.sendInventory();
    client._sendMeta();
    return true;
  }

  /** A save that gives up after `ms` (the kick flow must not hang). */
  saveWithTimeout(ms) {
    return Promise.race([this.save(true), new Promise((r) => setTimeout(() => r(false), ms))]);
  }

  /**
   * Spawn column: the scored spiral search (inland, plains / forest, gentle, not a peak), falling back to
   * the first land column outward from the origin when nothing within range qualifies.
   */
  _findSpawn(seed) {
    const gen = new WorldGenerator(seed);
    const best = findSpawnColumn(gen);
    if (best) return { x: best.x + 0.5, y: best.height + 1, z: best.z + 0.5 };
    const ok = (x, z) => gen.surfaceHeight(x, z) >= SEA_LEVEL + 2 && gen.biomeAt(x, z) !== BiomeIds.OCEAN;
    if (ok(0, 0)) return { x: 0.5, y: gen.surfaceHeight(0, 0) + 1, z: 0.5 };
    for (let r = 4; r < 600; r += 4) {
      for (let i = -r; i <= r; i += 4) {
        for (const [x, z] of [[i, -r], [i, r], [-r, i], [r, i]]) {
          if (ok(x, z)) return { x: x + 0.5, y: gen.surfaceHeight(x, z) + 1, z: z + 0.5 };
        }
      }
    }
    return { x: 0.5, y: 80, z: 0.5 };
  }

  /** Stream chunks around the player until the near area is meshed (with a timeout). */
  _streamSpawnArea() {
    const g = this.game;
    const p = g.player;
    const radius = Math.min(g.settings.get('renderDistance'), 5);
    const cx = Math.floor(p.position.x) >> 4, cz = Math.floor(p.position.z) >> 4;
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (!g.state.is(State.LOADING)) { resolve(); return; }
        g.chunkManager.update(p.position.x, p.position.z, 0, -1);
        const progress = g.chunkManager.progress(cx, cz, radius);
        g.ui.loading.setProgress(progress);
        if (progress >= 1 || performance.now() - start > LOAD_TIMEOUT_MS) { resolve(); return; }
        setTimeout(tick, 16); // timer, not rAF: keeps loading in background tabs
      };
      tick();
    });
  }

  /** Put a fresh player on the actual top block of the spawn column (caves may have carved it). */
  _settleOnSurface() {
    const g = this.game;
    const p = g.player;
    const x = Math.floor(p.position.x), z = Math.floor(p.position.z);
    let bestY = -1;
    for (let y = 255; y >= 0; y--) {
      const id = g.world.getBlock(x, y, z);
      if (id !== BlockIds.AIR && SOLID[id] === 1) { bestY = y; break; }
    }
    if (bestY >= 0) {
      p.teleport(x + 0.5, bestY + 1, z + 0.5);
      p.spawn.copy(p.position);
    }
  }

  /** Saved players may load inside a block if the world changed; nudge them up. */
  _settleIfBuried() {
    const g = this.game;
    const p = g.player;
    let guard = 0;
    while (guard++ < 64) {
      const x = Math.floor(p.position.x), z = Math.floor(p.position.z);
      const y0 = Math.floor(p.position.y + 0.1), y1 = Math.floor(p.position.y + PLAYER_HEIGHT - 0.1);
      if (!g.world.isSolid(x, y0, z) && !g.world.isSolid(x, y1, z)) break;
      p.teleport(p.position.x, p.position.y + 1, p.position.z);
    }
  }

  /** After a respawn at the world spawn: make sure the player is not inside blocks (the spawn column may have changed). */
  settleAfterRespawn() {
    const g = this.game;
    if (this.meta && !this.meta.remote) this.changedSinceSave = true;
    this._settleIfBuried();
    void g;
  }

  /** The game mode column is written right away (fire and forget; a failure only shows the toast). */
  gameModeChanged(mode) {
    if (!this.meta) return;
    this.meta.gameMode = mode;
    if (this.meta.remote) return; // guests only tell the host (GuestClient listens to gamemode:changed)
    this.changedSinceSave = true;
    this.game.saveManager.updateGameMode(this.meta.id, mode).catch(() => this._saveFailed([]));
  }

  /**
   * Persist player, inventory, entities and the dirty chunk edits. Returns true on success. On failure
   * the dirty chunks are kept, a toast says "Couldn't save, retrying…" and the next autosave comes
   * sooner with growing backoff — edits are never dropped silently.
   */
  async save(full = false) {
    const g = this.game;
    if (!this.meta || this.saving) return false;
    if (this.meta.remote) { // a guest's "save" is its player data and inventory sent to the host
      this.changedSinceSave = false;
      return g.net && !g.net.isHost ? g.net.sendInventory() : true;
    }
    this.saving = true;
    const edits = g.world.edits;
    const keys = full ? [...edits.chunks.keys()] : edits.takeDirtyKeys();
    if (full) edits.dirtyKeys.clear();
    try {
      const meta = this.meta;
      meta.player = g.player.serialize();
      meta.inventory = g.inventory.serialize();
      meta.entities = g.entities.serialize();
      meta.mobs = g.entities.mobs ? g.entities.mobs.serialize() : [];
      meta.spawnedChunks = [...this.spawnedChunks];
      meta.gameMode = g.player.gameMode;
      meta.perspective = g.cameraController.perspective;
      const entries = keys.map((key) => ({ key, ...edits.serializeChunk(key) })).filter((e) => e.indices);
      this.changedSinceSave = false;
      await g.saveManager.saveChunks(meta.id, entries);
      await g.saveManager.saveWorld(meta);
      if (this.lastSaveFailed) g.ui.hud.hideToast();
      this.lastSaveFailed = false;
      this.retryIndex = 0;
      this.autosaveTimer = AUTOSAVE_SECONDS;
      return true;
    } catch (e) {
      console.warn('WorldSession: save failed', e);
      this.changedSinceSave = true;
      this._saveFailed(keys);
      if (e && (e.status === 401 || /JWT|not authenticated|expired/i.test(String(e.message)))) g.events.emit('account:signedout');
      return false;
    } finally {
      this.saving = false;
    }
  }

  _saveFailed(keys) {
    for (const k of keys) this.game.world.edits.dirtyKeys.add(k);
    this.lastSaveFailed = true;
    this.autosaveTimer = RETRY_SECONDS[Math.min(this.retryIndex++, RETRY_SECONDS.length - 1)];
    this.game.ui.hud.showToast("Couldn't save, retrying…", true);
  }

  /** Called every frame while in a world. */
  update(dt) {
    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) {
      this.autosaveTimer = AUTOSAVE_SECONDS;
      this.save(false);
    }
  }

  /** Save & Quit: flush everything behind a "Saving…" overlay (a few quick retries), then leave. */
  async quit() {
    const g = this.game;
    if (!this.meta) return true;
    if (this.meta.remote) { g.leaveServer(); return true; }
    g.ui.loading.show('Saving…', { indeterminate: true });
    let ok = false;
    for (let attempt = 0; attempt <= QUIT_RETRY_MS.length && !ok; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, QUIT_RETRY_MS[attempt - 1]));
      ok = await this.save(true);
    }
    g.ui.loading.hide();
    if (!ok) {
      g.ui.hud.showToast("Couldn't save. Your changes are kept — try again in a moment.", false);
      return false;
    }
    this._leave();
    g.prefetchWorlds(); // the world list is fresh by the time the player clicks Play
    g.state.set(State.MENU);
    return true;
  }

  /** Leave without saving (the session was revoked); edits still in memory are dropped. */
  abandon() {
    this._leave();
  }

  _leave() {
    const g = this.game;
    g.input.exitPointerLock();
    g.chunkManager.clear();
    g.world.clear();
    g.entities.clear();
    g.entities.remote = false;
    if (g.entities.mobs) g.entities.mobs.remote = false;
    if (g.remotePlayers) g.remotePlayers.clear();
    g.waterSim.clear();
    g.audio.stopAmbient();
    if (this.lock) { this.lock.release(); this.lock = null; }
    this.meta = null;
    g.worldMeta = null;
    this.lastSaveFailed = false;
    this.changedSinceSave = false;
    g.ui.hud.hideToast();
  }
}
