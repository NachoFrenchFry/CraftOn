// GuestClient.js — joining a LAN server (Update #8): one WebRTC offer through the signals table, the HELLO /
// WELCOME handshake, the world download (seed, game mode, chunk edit diffs in compressed batches, mobs,
// items, players) and then play: the guest simulates its own movement and predicts its own block changes
// (sending requests the host validates; a rejection reverts the block), asks the host to pick up items and to
// hurt mobs, mirrors every host broadcast (blocks, water, mobs, items, other players), and sends its player
// data and inventory to the host for saving. Never uses Supabase Realtime.

import { PeerLink } from './PeerLink.js';
import { Signaling } from './Signaling.js';
import { Msg, RejectReason, GAME_VERSION, PLAYER_SNAPSHOT_HZ, JOIN_TIMEOUT_MS, encodePlayerState, decodeChunkRow } from './Protocol.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { MOB_BY_TYPE } from '../entities/mobs/MobSpawner.js';

const INV_SYNC_SECONDS = 2;

export class GuestClient {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.isHost = false;
    this.userId = game.account.session.user.id;
    this.name = game.account.username || 'player';
    this.signaling = new Signaling(game.cloud, this.userId);
    this.link = null;
    this.lobby = null;
    this.hostId = null;
    this.welcome = null;
    this.remote = game.remotePlayers;
    this.cancelled = false;
    this.connected = false;
    this.closed = false;
    this.applyingRemote = false;
    this.pendingBlocks = new Map();
    this.seq = 0;
    this.snapTimer = 0;
    this.invTimer = 0;
    this.invDirty = false;
    this.chunkRows = [];
    this.chunkTotal = 0;
    this._chunksDone = null;
    this._welcomeDone = null;
    this._unsubs = [];
    this.onProgress = null;
    this.onHostClosed = null;
  }

  /** Connect to a lobby: resolves with the WELCOME message (chunks keep streaming in afterwards). Throws with a friendly message. */
  async connect(lobby, timeoutMs = JOIN_TIMEOUT_MS) {
    if (lobby.game_version !== GAME_VERSION) throw new Error(RejectReason.VERSION);
    if (lobby.player_count >= lobby.max_players) throw new Error(RejectReason.FULL);
    this.lobby = lobby;
    this.hostId = lobby.host_id;
    const started = Date.now();
    const remaining = () => Math.max(500, timeoutMs - (Date.now() - started));
    const welcomePromise = new Promise((resolve, reject) => { this._welcomeDone = { resolve, reject }; });
    this._chunksPromise = new Promise((resolve) => { this._chunksDone = resolve; });
    this.link = new PeerLink({
      iceServers: [],
      onMessage: (msg, channel) => this._onMessage(msg, channel),
      onOpen: () => { this.connected = true; this.link.send(Msg.HELLO, { userId: this.userId, name: this.name, version: GAME_VERSION, instanceId: this.game.sessionGuard ? this.game.sessionGuard.instanceId : '' }); },
      onClose: (reason) => this._closed(reason),
    });
    const offer = await this.link.createOffer();
    await this.signaling.send(lobby.id, lobby.host_id, 'offer', { sdp: offer });
    const row = await this.signaling.waitFor(lobby.id, ['answer', 'reject'], remaining(), () => this.cancelled);
    if (!row) { this.close(false); throw new Error(this.cancelled ? 'Cancelled.' : 'The host did not answer (offline?). Timed out.'); }
    if (row.kind === 'reject') { this.close(false); throw new Error(row.payload && row.payload.reason ? row.payload.reason : 'The host rejected the connection.'); }
    await this.link.acceptAnswer(row.payload.sdp);
    const timer = setTimeout(() => { if (!this.connected) this._welcomeDone.reject(new Error("Couldn't connect to the host. Some networks (school, office or guest Wi-Fi) block devices from talking to each other.")); }, remaining());
    try {
      const welcome = await welcomePromise;
      clearTimeout(timer);
      this.welcome = welcome;
      this._wire();
      return welcome;
    } catch (e) {
      clearTimeout(timer);
      this.close(false);
      throw e;
    }
  }

  /** Resolves with every chunk row once the host sent them all; `onProgress(received, total)` reports batches. */
  chunks() { return this._chunksPromise; }

  _wire() {
    const g = this.game, ev = g.events;
    const on = (name, fn) => this._unsubs.push(ev.on(name, fn));
    on('block:changed', (x, y, z, info) => {
      if (this.applyingRemote || !info || info.recorded === false) return;
      const seq = ++this.seq;
      this.pendingBlocks.set(seq, { x, y, z, old: info.old });
      if (this.pendingBlocks.size > 256) this.pendingBlocks.delete(this.pendingBlocks.keys().next().value);
      this.link.send(Msg.BLOCK, { x, y, z, id: info.id, seq });
    });
    on('player:swing', () => this.link.send(Msg.SWING));
    on('mining:progress', (x, y, z, p) => this.link.send(Msg.MINING, { x, y, z, p }));
    on('mining:stop', () => this.link.send(Msg.MINING, { stop: true }));
    on('inventory:changed', () => { this._sendMeta(); this.invDirty = true; });
    on('inventory:selected', () => this._sendMeta());
    on('gamemode:changed', () => this._sendMeta());
    on('player:attack', (mobId, damage, crit) => this.link.send(Msg.ATTACK, { id: mobId, damage, crit }));
    on('item:pickupRequest', (it) => this.link.send(Msg.PICKUP, { id: it.id }));
    on('player:equip', (armor) => { const p = g.player.position; this.link.send(Msg.SOUND, { name: armor.material === 'wood' ? 'player.equip_wood' : 'player.equip_metal', x: p.x, y: p.y + 1, z: p.z, vol: 0.8 }); });
    g.entities.throwHook = (itemId, count, x, y, z, vx, vy, vz) => this.link.send(Msg.THROW, { item: itemId, n: count, x, y, z, vx, vy, vz });
  }

  _sendMeta() {
    const g = this.game;
    const s = g.inventory.getSelected();
    this.link.send(Msg.META, { held: s ? s.itemId : 0, armor: g.inventory.armorMaterials(), mode: g.player.gameMode });
  }

  /** Player data + inventory for the host's save (also used by the guest's "autosave"). */
  sendInventory() {
    if (!this.link || !this.link.open) return false;
    const g = this.game;
    this.link.send(Msg.INV, { player: g.player.serialize(), inventory: g.inventory.serialize() });
    this.invDirty = false;
    return true;
  }

  _onMessage(msg, channel) {
    const g = this.game;
    switch (msg.t) {
      case Msg.WELCOME: if (this._welcomeDone) this._welcomeDone.resolve(msg); return;
      case Msg.REJECT: if (this._welcomeDone) this._welcomeDone.reject(new Error(msg.reason || 'Rejected.')); return;
      case Msg.CHUNKS: this.chunkRows.push(...(msg.rows || [])); if (this.onProgress) this.onProgress(this.chunkRows.length, this.welcome ? this.welcome.chunkCount : null); if (msg.done && this._chunksDone) { this._chunksDone(this.chunkRows); this._chunksDone = null; } return;
      case Msg.BLOCKS: for (const b of msg.list) this._applyBlock(b[0], b[1], b[2], b[3], b[4], b[5]); return;
      case Msg.BLOCK: this._applyBlock(msg.x, msg.y, msg.z, msg.id, msg.by, msg.kind); return;
      case Msg.BLOCK_REJECT: { const p = this.pendingBlocks.get(msg.seq); this.pendingBlocks.delete(msg.seq); this._applyBlock(msg.x, msg.y, msg.z, msg.id, null, 'revert'); if (p) g.ui.hud.showToast("The host didn't allow that change", false); return; }
      case Msg.PS: { const now = performance.now() / 1000; for (const row of msg.list) { const id = row[0]; if (id === this.userId) continue; const rp = this.remote.get(id) || this.remote.add(id, id === this.hostId && this.welcome ? this.welcome.hostName : 'player'); rp.snapshot(now, row.slice(1)); } return; }
      case Msg.M: { if (g.entities.mobs) g.entities.mobs.applySnapshot(msg.mobs, performance.now() / 1000); g.entities.applySnapshot(msg.items); return; }
      case Msg.JOIN: { const rp = this.remote.add(msg.id, msg.name); if (msg.held !== undefined) rp.setMeta(msg); g.ui.hud.showToast(`${msg.name} joined`, false); return; }
      case Msg.LEAVE: { const rp = this.remote.get(msg.id); if (rp) g.ui.hud.showToast(`${rp.name} left`, false); this.remote.remove(msg.id); return; }
      case Msg.META: { const rp = this.remote.get(msg.id); if (rp) rp.setMeta(msg); return; }
      case Msg.SWING: { const rp = this.remote.get(msg.id); if (rp) rp.swing(); return; }
      case Msg.MINING: { const rp = this.remote.get(msg.id); if (rp) { if (msg.stop) rp.miningStop(); else rp.mining(msg.x, msg.y, msg.z, msg.p); } return; }
      case Msg.SOUND: g.audio.playAt(msg.name, msg.x, msg.y, msg.z, 'blocks', msg.vol || 0.8); return;
      case Msg.MOB_SPAWN: g.entities.mobs.spawnRemote(msg); return;
      case Msg.MOB_REMOVE: g.entities.mobs.removeById(msg.id); return;
      case Msg.MOB_HURT: g.entities.mobs.hurtRemote(msg); return;
      case Msg.ITEM_SPAWN: g.entities.spawnItem(msg.x, msg.y, msg.z, msg.item, msg.n, msg.vx, msg.vy, msg.vz, 0.25, msg.id); return;
      case Msg.ITEM_REMOVE: g.entities.removeById(msg.id); return;
      case Msg.ITEM_GRANT: { const left = g.inventory.addItem(msg.item, msg.n); if (left < msg.n) g.events.emit('item:pickup', msg.item, msg.n - left); return; }
      case Msg.HOST_CLOSED: this._closed('host closed'); return;
      default: return;
    }
  }

  /** A host-authoritative block: apply without re-sending; play the other player's break / place effects. */
  _applyBlock(x, y, z, id, by, kind) {
    const g = this.game;
    const cur = g.world.getBlock(x, y, z);
    this.applyingRemote = true;
    try {
      if (!g.world.isLoadedAt(x, z)) g.world.edits.record(x >> 4, z >> 4, (x & 15) + ((z & 15) << 4) + (y << 8), id); // keep it for when the chunk generates
      else g.world.setBlock(x, y, z, id, true);
    } finally { this.applyingRemote = false; }
    if (by && by !== this.userId && cur !== id) {
      if (kind === 'break') { g.audio.playBlock('break', cur, x + 0.5, y + 0.5, z + 0.5); g.particles.spawnBlockBreak(x, y, z, cur, 12); }
      else if (kind === 'place') g.audio.playBlock('place', id, x + 0.5, y + 0.5, z + 0.5);
    }
  }

  /** Per frame: snapshots at 20 Hz, a throttled inventory sync, the remote players. */
  update(dt) {
    if (!this.link || !this.link.open) return;
    this.snapTimer += dt;
    if (this.snapTimer >= 1 / PLAYER_SNAPSHOT_HZ) { this.snapTimer = 0; this.link.send(Msg.P, { s: encodePlayerState(this.game.player) }, 'state'); }
    if (this.invDirty) { this.invTimer += dt; if (this.invTimer >= INV_SYNC_SECONDS) { this.invTimer = 0; this.sendInventory(); } }
  }

  _closed(reason) {
    if (this.closed) return;
    console.info(`CraftOn net: connection to the host ended (${reason})`);
    this.closed = true;
    this.connected = false;
    if (this._welcomeDone) this._welcomeDone.reject(new Error(reason === 'host closed' ? RejectReason.CLOSED : 'Connection lost.'));
    if (this.onHostClosed) this.onHostClosed(reason);
  }

  /** Leave: tell the host, drop the link, forget the remote players. */
  close(sendBye = true) {
    this.cancelled = true;
    if (this.link) { if (sendBye) { try { this.sendInventory(); this.link.send(Msg.BYE); } catch (e) { /* ignore */ } } this.link.close(); }
    this.closed = true;
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    this.game.entities.throwHook = null;
    this.remote.clear();
    if (this.lobby) this.signaling.clear(this.lobby.id);
  }
}

export { MOB_BY_TYPE, BlockRegistry };
