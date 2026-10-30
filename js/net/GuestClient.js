// GuestClient.js — joining a LAN server: one WebRTC offer through the signals table, the HELLO /
// WELCOME handshake, the world download (seed, game mode, chunk edit diffs in compressed batches, mobs,
// items, players) and then play: the guest simulates its own movement and predicts its own block changes
// (sending requests the host validates; a rejection reverts the block), asks the host to pick up items and to
// hurt mobs, mirrors every host broadcast (blocks, water, mobs, items, other players), and sends its player
// data and inventory to the host for saving. The link uses STUN + TURN (IceServers.js), so hosts on
// other networks are reachable too; a KICK from the host ends the session with the host's reason. Never uses Supabase Realtime.

import { PeerLink } from './PeerLink.js';
import { getIceServers } from './IceServers.js';
import { ItemStack } from '../items/ItemStack.js';
import { Signaling } from './Signaling.js';
import { Msg, RejectReason, PLAYER_SNAPSHOT_HZ, JOIN_TIMEOUT_MS, encodePlayerState, decodeChunkRow } from './Protocol.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { MOB_BY_TYPE } from '../entities/mobs/MobSpawner.js';

const INV_SYNC_SECONDS = 2;

/** Time allowed for the ICE connection and the WELCOME once the host's answer arrived (a relay can take a few seconds). */
const CONNECT_TIMEOUT_MS = JOIN_TIMEOUT_MS;

/** Toast per host rejection reason; unlisted reasons (stale request, rule) stay silent. */
const REJECT_TEXT = Object.freeze({ far: 'Too far away', entity: 'Something is in the way' });

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
    /** { iceServers, turn, note } used for this link (F3). */
    this.ice = null;
    /** The host's reason when it kicked or banned us. */
    this.kickReason = null;
    /** Whether the host lets this guest change its own game mode (the host decides). */
    this.canChangeMode = false;
    this.healthDirty = false; this.healthTimer = 0;
    this.remote = game.remotePlayers;
    this.cancelled = false;
    this.connected = false;
    this.closed = false;
    this.applyingRemote = false;
    this.pendingBlocks = new Map();
    this.seq = 0;
    this.chestSeq = 0;
    this.chestPending = new Map();
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
    if (lobby.player_count >= lobby.max_players) throw new Error(RejectReason.FULL);
    this.lobby = lobby;
    this.hostId = lobby.host_id;
    const started = Date.now();
    const remaining = () => Math.max(500, timeoutMs - (Date.now() - started));
    const welcomePromise = new Promise((resolve, reject) => { this._welcomeDone = { resolve, reject }; });
    this._chunksPromise = new Promise((resolve) => { this._chunksDone = resolve; });
    const g = this.game;
    this.ice = await getIceServers(g.cloud, { mock: g.cloudMock }); // without a relay the link quietly uses STUN only
    this.link = new PeerLink({
      iceServers: this.ice.iceServers,
      onMessage: (msg, channel) => this._onMessage(msg, channel),
      onOpen: () => { this.connected = true; this.link.send(Msg.HELLO, { userId: this.userId, name: this.name, instanceId: this.game.sessionGuard ? this.game.sessionGuard.instanceId : '' }); },
      onClose: (reason) => this._closed(reason),
    });
    const offer = await this.link.createOffer();
    // Each attempt carries a nonce: an answer left over from an earlier attempt (its ports are long gone) is ignored.
    this.attempt = Math.random().toString(36).slice(2, 10);
    await this.signaling.send(lobby.id, lobby.host_id, 'offer', { sdp: offer, attempt: this.attempt });
    const row = await this.signaling.waitFor(lobby.id, ['answer', 'reject'], remaining(), () => this.cancelled, (r) => !r.payload || !r.payload.attempt || r.payload.attempt === this.attempt);
    if (!row) { const cancelled = this.cancelled; this.close(false); throw new Error(cancelled ? 'Cancelled.' : 'The host did not answer (offline?). Timed out.'); }
    if (row.kind === 'reject') { this.close(false); throw new Error(row.payload && row.payload.reason ? row.payload.reason : 'The host rejected the connection.'); }
    await this.link.acceptAnswer(row.payload.sdp);
    // The answer is here: the ICE connection gets its own budget (the signaling may have used most of the first one).
    const timer = setTimeout(() => { if (!this.connected) this._welcomeDone.reject(new Error(RejectReason.UNREACHABLE)); }, Math.max(remaining(), CONNECT_TIMEOUT_MS));
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
    // Remember which item a placement consumed so a rejection can give it back.
    on('block:placed', (x, y, z, id, consumed) => {
      const p = this.pendingBlocks.get(this.seq);
      if (p && consumed && p.x === x && p.y === y && p.z === z) { p.item = consumed.itemId; p.slot = consumed.slot; }
    });
    on('player:swing', () => this.link.send(Msg.SWING));
    on('mining:progress', (x, y, z, p) => this.link.send(Msg.MINING, { x, y, z, p }));
    on('mining:stop', () => this.link.send(Msg.MINING, { stop: true }));
    on('inventory:changed', () => { this._sendMeta(); this.invDirty = true; });
    on('inventory:selected', () => this._sendMeta());
    on('gamemode:changed', () => this._sendMeta());
    on('player:attack', (mobId, damage, crit, kb) => this.link.send(Msg.ATTACK, { id: mobId, damage, crit, kb: kb || 1 }));
    on('player:spawnEgg', (type, x, y, z) => this.link.send(Msg.SPAWN_EGG, { type, x, y, z }));
    // Health: hits on other players go to the host; our health and deaths are reported.
    on('player:hitPlayer', (targetId, crit) => this.link.send(Msg.HIT, { target: targetId, crit }));
    on('player:damaged', () => { this.link.send(Msg.HEALTH, { hp: g.player.health, hurt: true }); this.healthDirty = false; });
    on('player:health', () => { this.healthDirty = true; });
    on('player:died', (cause) => this.link.send(Msg.DEATH, { cause }));
    on('player:respawn', () => this.requestRespawn('void')); // a Creative / Spectator void fall put us back at the spawn: tell the host
    on('item:pickupRequest', (it) => this.link.send(Msg.PICKUP, { id: it.id }));
    on('player:equip', (armor) => { const p = g.player.position; this.link.send(Msg.SOUND, { name: armor.material === 'wood' ? 'player.equip_wood' : 'player.equip_metal', x: p.x, y: p.y + 1, z: p.z, vol: 0.8 }); });
    g.entities.throwHook = (itemId, count, x, y, z, vx, vy, vz) => this.link.send(Msg.THROW, { item: itemId, n: count, x, y, z, vx, vy, vz });
  }

  _sendMeta() {
    const g = this.game;
    const s = g.inventory.getSelected();
    this.link.send(Msg.META, { held: s ? s.itemId : 0, armor: g.inventory.armorMaterials(), mode: g.player.gameMode });
  }

  /** Shoot through the host: it validates (origin near the eyes, power, cooldown, arrows) and spawns the arrow for everyone. */
  shoot(eye, dir, power) { if (this.link && this.link.open) this.link.send(Msg.SHOOT, { ox: eye.x, oy: eye.y, oz: eye.z, dx: dir.x, dy: dir.y, dz: dir.z, power }); }

  /** A chest opened: the host sends its real contents. */
  chestOpen(x, y, z) { if (this.link && this.link.open) this.link.send(Msg.CHEST_OPEN, { x, y, z }); }

  /** A chest operation: resolves with the host's CHEST_ACK (ok, cursor / stack / n), or { ok: false } after 5 s. */
  chestOp(x, y, z, op) {
    if (!this.link || !this.link.open) return Promise.resolve({ ok: false });
    const seq = ++this.chestSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.chestPending.delete(seq); resolve({ ok: false }); }, 5000);
      this.chestPending.set(seq, (ack) => { clearTimeout(timer); resolve(ack); });
      this.link.send(Msg.CHEST_OP, { seq, x, y, z, ...op });
    });
  }

  /** A rocket while gliding: the host checks the inventory and the cooldown and answers ROCKET_OK. */
  rocket() { if (this.link && this.link.open) this.link.send(Msg.ROCKET, {}); }

  /** A placed explosive goes through the host (it primes the entity for everyone, or refuses when explosives are off). */
  prime(x, y, z) { if (this.link && this.link.open) this.link.send(Msg.PRIME, { x, y, z }); }

  /** Ask the host to place us (a respawn, or a void jump): the host resets its movement baseline and answers with SPAWN_AT. */
  requestRespawn(reason = 'respawn') { if (this.link && this.link.open) this.link.send(Msg.RESPAWN, { reason }); }

  /** A chat line typed here goes to the host, which validates it and sends it to everyone (this guest included). */
  sendChat(text) { if (this.link && this.link.open) this.link.send(Msg.CHAT, { text }); }

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
    if (!msg || typeof msg.t !== 'string') return; // malformed: ignored
    switch (msg.t) {
      case Msg.WELCOME: if (this._welcomeDone) this._welcomeDone.resolve(msg); return;
      case Msg.REJECT: if (this._welcomeDone) this._welcomeDone.reject(new Error(msg.reason || 'Rejected.')); return;
      case Msg.CHUNKS: this.chunkRows.push(...(msg.rows || [])); if (this.onProgress) this.onProgress(this.chunkRows.length, this.welcome ? this.welcome.chunkCount : null); if (msg.done && this._chunksDone) { this._chunksDone(this.chunkRows); this._chunksDone = null; } return;
      case Msg.BLOCKS: for (const b of msg.list) this._applyBlock(b[0], b[1], b[2], b[3], b[4], b[5]); return;
      case Msg.BLOCK: this._applyBlock(msg.x, msg.y, msg.z, msg.id, msg.by, msg.kind); return;
      case Msg.BLOCK_REJECT: { const p = this.pendingBlocks.get(msg.seq); this.pendingBlocks.delete(msg.seq); this._applyBlock(msg.x, msg.y, msg.z, msg.id, null, 'revert'); if (p) this._refund(p, msg.reason); return; }
      case Msg.PS: { const now = performance.now() / 1000; for (const row of msg.list) { const id = row[0]; if (id === this.userId) continue; const rp = this.remote.get(id) || this.remote.add(id, id === this.hostId && this.welcome ? this.welcome.hostName : 'player'); rp.snapshot(now, row.slice(1)); } return; }
      case Msg.M: { if (g.entities.mobs) g.entities.mobs.applySnapshot(msg.mobs, performance.now() / 1000); g.entities.applySnapshot(msg.items); if (msg.ex) g.entities.applyExplosiveSnapshot(msg.ex); return; }
      case Msg.JOIN: { const rp = this.remote.add(msg.id, msg.name); if (msg.held !== undefined) rp.setMeta(msg); return; } // the host's chat line announces the join
      case Msg.LEAVE: { this.remote.remove(msg.id); return; }
      case Msg.META: { const rp = this.remote.get(msg.id); if (rp) rp.setMeta(msg); return; }
      case Msg.MODE: { this.canChangeMode = !!msg.canChange; if (msg.mode && g.player.gameMode !== msg.mode) g.setGameMode(msg.mode, true); return; }
      case Msg.DAMAGE: { g.health.damage(msg.n, { kind: msg.kind || 'pvp', by: msg.by }, { kx: msg.kx || 0, kz: msg.kz || 0, crit: !!msg.crit, ignoreInvuln: true }); if (msg.ky) { g.player.velocity.y += Number(msg.ky) || 0; g.cameraController.shake(0.6); } return; }
      case Msg.HURT: { const rp = this.remote.get(msg.id); if (rp) rp.hurt(!!msg.crit, msg.n | 0); return; }
      case Msg.DEATH: if (msg.text) g.ui.chat.system(String(msg.text).slice(0, 256), 'yellow'); return;
      case Msg.CHAT: if (msg.system !== undefined) g.ui.chat.system(String(msg.system).slice(0, 256), msg.color === 'gray' || msg.color === 'red' ? msg.color : 'yellow'); else if (msg.name && msg.text) g.ui.chat.add({ name: String(msg.name).slice(0, 16), text: String(msg.text).slice(0, 256), host: !!msg.host }); return;
      case Msg.TICK: g.setTickRate(Number(msg.rate) || 20, true); g.setTickFrozen(!!msg.frozen, true); return;
      case Msg.WORLD: if (g.worldMeta) { g.worldMeta.keepInventory = !!msg.keepInventory; g.worldMeta.pvp = msg.pvp !== false; g.worldMeta.hostileMobs = msg.hostileMobs !== false; g.worldMeta.explosives = msg.explosives !== false; g.worldMeta.explosionsBreakBlocks = msg.explosionsBreakBlocks !== false; } return;
      case Msg.SWING: { const rp = this.remote.get(msg.id); if (rp) rp.swing(); return; }
      case Msg.MINING: { const rp = this.remote.get(msg.id); if (rp) { if (msg.stop) rp.miningStop(); else rp.mining(msg.x, msg.y, msg.z, msg.p); } return; }
      case Msg.SOUND: g.audio.playAt(msg.name, msg.x, msg.y, msg.z, 'blocks', msg.vol || 0.8); return;
      case Msg.MOB_SPAWN: g.entities.mobs.spawnRemote(msg); return;
      case Msg.MOB_REMOVE: g.entities.mobs.removeById(msg.id); return;
      case Msg.MOB_HURT: g.entities.mobs.hurtRemote(msg); return;
      case Msg.ITEM_SPAWN: g.entities.spawnItem(msg.x, msg.y, msg.z, msg.item, msg.n, msg.vx, msg.vy, msg.vz, 0.25, msg.id); return;
      case Msg.ITEM_REMOVE: g.entities.removeById(msg.id); return;
      case Msg.ARROW_SPAWN: { const len = Math.hypot(msg.vx, msg.vy, msg.vz) || 1; g.entities.shootArrow({ x: msg.x, y: msg.y, z: msg.z }, { x: msg.vx / len, y: msg.vy / len, z: msg.vz / len }, msg.power, msg.shooter === this.userId ? 'self' : msg.shooter, { pickup: !!msg.pickup, id: msg.id, remote: true, crit: !!msg.crit, vx: msg.vx, vy: msg.vy, vz: msg.vz }); return; }
      case Msg.ARROW_STUCK: g.entities.stickArrowAt(msg.id, msg.x, msg.y, msg.z); return;
      case Msg.ARROW_REMOVE: g.entities.removeArrow(g.entities.arrowById(msg.id)); return;
      case Msg.EXPLOSIVE_SPAWN: g.entities.primeExplosive(msg.x, msg.y, msg.z, msg.fuse, { vx: msg.vx, vy: msg.vy, vz: msg.vz, id: msg.id, remote: true, exact: true }); return;
      case Msg.EXPLOSION: g.entities.explodeRemote(msg.id, msg.x, msg.y, msg.z, msg.power); return;
      case Msg.ROCKET_OK: g._fireRocket(); return;
      case Msg.CHEST_CONTENTS: g.chests.applyRemoteContents(msg.x, msg.y, msg.z, msg.slots); return;
      case Msg.CHEST_SLOT: if (msg.slot === -1) g.chests.applyRemoteContents(msg.x, msg.y, msg.z, msg.slots); else g.chests.applyRemoteSlot(msg.x, msg.y, msg.z, msg.slot | 0, msg.stack || null); return;
      case Msg.CHEST_ACK: { const fn = this.chestPending.get(msg.seq); if (fn) { this.chestPending.delete(msg.seq); fn(msg); } return; }
      case Msg.ITEM_GRANT: { const left = g.inventory.addItem(msg.item, msg.n); if (left < msg.n) g.events.emit('item:pickup', msg.item, msg.n - left); return; }
      case Msg.SPAWN_AT: g.health.placeAt(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0, msg.reason); return;
      case Msg.HOST_CLOSED: this._closed('host closed'); return;
      case Msg.KICK: this.kickReason = msg.reason === RejectReason.BANNED ? RejectReason.BANNED : RejectReason.KICKED; this._closed(this.kickReason === RejectReason.BANNED ? 'banned' : 'kicked'); return;
      default: return;
    }
  }

  /** A host-authoritative block: apply without re-sending; play the other player's break / place effects. */
  /**
   * A rejected placement gives the item back: into the slot it came from, else anywhere in the
   * inventory, else dropped at the feet (the host spawns the drop). Only real reasons show a short message;
   * a stale request (someone else changed that block first) is silent.
   */
  _refund(p, reason) {
    const g = this.game;
    if (p.item != null && !g.player.isCreative) {
      const inv = g.inventory;
      let left = 1;
      const s = inv.slots[p.slot];
      if (s === null && inv.acceptsAt(p.slot, p.item)) { inv.slots[p.slot] = new ItemStack(p.item, 1); left = 0; inv.changed(); }
      else if (s && s.itemId === p.item && s.count < s.maxStack) { s.count++; left = 0; inv.changed(); }
      if (left) left = inv.addItem(p.item, left);
      if (left) { const pos = g.player.position; this.link.send(Msg.THROW, { item: p.item, n: left, x: pos.x, y: pos.y + 0.5, z: pos.z, vx: 0, vy: 0, vz: 0 }); }
    }
    const text = REJECT_TEXT[reason];
    if (text) g.ui.hud.showToast(text, false);
  }

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
    if (this.healthDirty) { this.healthTimer = (this.healthTimer || 0) + dt; if (this.healthTimer >= 1) { this.healthTimer = 0; this.healthDirty = false; this.link.send(Msg.HEALTH, { hp: this.game.player.health, hurt: false }); } }
  }

  _closed(reason) {
    if (this.closed) return;
    console.info(`CraftOn net: connection to the host ended (${reason})`);
    this.closed = true;
    this.connected = false;
    if (this._welcomeDone) this._welcomeDone.reject(new Error(reason === 'host closed' ? RejectReason.CLOSED : this.kickReason || 'Connection lost.'));
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
