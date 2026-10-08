// HostServer.js — the host's game tab is the server (Update #8): it publishes a lobby row (plain REST), answers
// WebRTC offers found by polling the signals table, and runs the authoritative world for every guest: blocks
// (guest requests are validated — reach, game mode, block rules — then broadcast, or rejected so the guest
// reverts), the water simulation, mobs (AI, health, death, drops), dropped items and pickups (granted to exactly
// one player), and time. Each player owns their own movement (light sanity checks) and inventory; guests' player
// data is stored in the host's world save under `guests[userId]`. Snapshots of every player go out at 20 Hz and
// of mobs / items at 12 Hz on the unreliable state channel; everything else on the reliable channel.
// Never uses Supabase Realtime.

import { PeerLink } from './PeerLink.js';
import { playerBlocksAt, playerHeightForPose, mobBlocksAt } from '../player/PlacementRules.js';
import { pvpDamage, PVP_REACH, PVP_REACH_SLACK, deathMessage } from '../player/Damage.js';
import { attackDamage } from '../items/Tools.js';
import { ARMOR_POINTS } from '../items/ItemDefinitions.js';
import { Signaling } from './Signaling.js';
import { detectNetworkHash, networkHash } from './NetworkId.js';
import { RemotePlayerManager } from './RemotePlayer.js';
import { Msg, RejectReason, GAME_VERSION, MAX_PLAYERS_DEFAULT, PLAYER_SNAPSHOT_HZ, MOB_SNAPSHOT_HZ, encodePlayerState, decodePlayerState, encodeChunkBatches, makeJoinCode, Pose } from './Protocol.js';
import { BlockRegistry, BREAK_TIME, SOLID, NEEDS_SUPPORT } from '../blocks/BlockRegistry.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { isWater } from '../world/WaterLevels.js';
import { REACH_CREATIVE, ITEM_PICKUP_EXPAND_XZ, ITEM_PICKUP_EXPAND_Y, PLAYER_WIDTH, PLAYER_HEIGHT } from '../config/Constants.js';
import { ITEM_HALF } from '../entities/ItemEntity.js';

const LOBBY_HEARTBEAT_MS = 10000;
const OFFER_POLL_MS = 1000;
const MAX_MOVE_PER_SNAPSHOT = 40;   // blocks: anything faster is treated as a glitch and ignored
const CHUNK_SEND_HIGH_WATER = 1 << 20;

const MODES = ['survival', 'creative', 'spectator'];

export class HostServer {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {{ maxPlayers?: number }} [opts]
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.maxPlayers = Math.max(2, Math.min(8, opts.maxPlayers || MAX_PLAYERS_DEFAULT));
    this.isHost = true;
    this.userId = game.account.session.user.id;
    this.name = game.account.username || 'host';
    this.signaling = new Signaling(game.cloud, this.userId);
    this.lobby = null;
    this.joinCode = makeJoinCode();
    this.networkDetected = true;
    /** userId → peer record */
    this.peers = new Map();
    this.pending = new Map();
    this.remote = game.remotePlayers;
    this.running = false;
    this.timers = [];
    this.blockQueue = [];
    this.snapTimer = 0;
    this.mobTimer = 0;
    this.seqTime = 0;
    this.applyingFor = null;
    this.offerPoll = null;
    this.polling = false;
    this._unsubs = [];
  }

  get playerCount() { return 1 + this.peers.size; }
  get worldName() { return this.game.worldMeta ? this.game.worldMeta.name : ''; }

  /** Publish the lobby and start answering offers. Throws when the lobby cannot be published. */
  async start() {
    const g = this.game;
    const net = await detectNetworkHash({ mock: g.cloudMock });
    this.networkDetected = net.detected;
    // Without a detectable public address the lobby still exists for Join by code, under a hash nobody shares.
    const hash = net.hash || await networkHash('unknown:' + this.userId);
    const res = await g.cloud.from('lobbies').upsert({
      world_name: String(this.worldName || 'World').slice(0, 32), network_hash: hash, join_code: this.joinCode,
      player_count: 1, max_players: this.maxPlayers, game_version: GAME_VERSION,
    }, { onConflict: 'host_id' }).select('id, join_code').single();
    if (res.error) throw new Error('publish lobby: ' + (res.error.message || res.error));
    this.lobby = res.data;
    g.worldMeta.guests = g.worldMeta.guests || {};
    this.running = true;
    this.timers.push(setInterval(() => this._heartbeat(), LOBBY_HEARTBEAT_MS));
    this.timers.push(setInterval(() => this._pollOffers(), OFFER_POLL_MS));
    this._wire();
    this._pagehide = () => this.stop('pagehide');
    window.addEventListener('pagehide', this._pagehide);
    return this;
  }

  _wire() {
    const ev = this.game.events;
    const on = (name, fn) => this._unsubs.push(ev.on(name, fn));
    on('block:changed', (x, y, z, info) => {
      const by = this.applyingFor ? this.applyingFor.by : this.userId;
      const kind = isWater(info.id) || isWater(info.old) ? 'flow' : info.id === 0 ? 'break' : 'place';
      this.blockQueue.push([x, y, z, info.id, by, kind]);
    });
    on('player:swing', () => this.broadcast(Msg.SWING, { id: this.userId }));
    on('mining:progress', (x, y, z, p) => this.broadcast(Msg.MINING, { id: this.userId, x, y, z, p }));
    on('mining:stop', () => this.broadcast(Msg.MINING, { id: this.userId, stop: true }));
    on('inventory:changed', () => this._sendOwnMeta());
    on('inventory:selected', () => this._sendOwnMeta());
    on('gamemode:changed', () => this._sendOwnMeta());
    on('player:equip', (armor) => { const p = this.game.player.position; this.broadcast(Msg.SOUND, { id: this.userId, name: armor.material === 'wood' ? 'player.equip_wood' : 'player.equip_metal', x: p.x, y: p.y + 1, z: p.z, vol: 0.8 }); });
    const mobs = this.game.entities.mobs;
    mobs.onSpawn = (m) => this.broadcast(Msg.MOB_SPAWN, this._mobRow(m));
    mobs.onRemove = (m) => this.broadcast(Msg.MOB_REMOVE, { id: m.id });
    mobs.onHurt = (m, died, crit, fromX, fromZ) => this.broadcast(Msg.MOB_HURT, { id: m.id, health: m.health, fromX, fromZ, crit, died });
    const items = this.game.entities;
    items.onSpawn = (it) => this.broadcast(Msg.ITEM_SPAWN, this._itemRow(it));
    items.onRemove = (it) => this.broadcast(Msg.ITEM_REMOVE, { id: it.id });
  }

  _unwire() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    const mobs = this.game.entities.mobs; if (mobs) { mobs.onSpawn = null; mobs.onRemove = null; mobs.onHurt = null; }
    const items = this.game.entities; items.onSpawn = null; items.onRemove = null;
  }

  _mobRow(m) { return { id: m.id, type: m.type, x: m.position.x, y: m.position.y, z: m.position.z, yaw: m.yaw, health: m.health }; }
  _itemRow(it) { return { id: it.id, item: it.itemId, n: it.count, x: it.position.x, y: it.position.y, z: it.position.z, vx: it.velocity.x, vy: it.velocity.y, vz: it.velocity.z }; }

  _ownMeta() {
    const g = this.game;
    const s = g.inventory.getSelected();
    return { id: this.userId, held: s ? s.itemId : 0, armor: g.inventory.armorMaterials(), mode: g.player.gameMode };
  }
  _sendOwnMeta() { if (this.peers.size) this.broadcast(Msg.META, this._ownMeta()); }

  async _heartbeat() {
    if (!this.running || !this.lobby) return;
    try { await this.game.cloud.from('lobbies').update({ player_count: this.playerCount }).eq('id', this.lobby.id); } catch (e) { /* retried next time */ }
  }

  async _pollOffers() {
    if (!this.running || !this.lobby || this.polling) return;
    this.polling = true;
    // Forget negotiations that never opened a channel within 45 s.
    for (const [id, p] of this.pending) if (!p.ready && performance.now() - (p.since || 0) > 45000) { try { p.link && p.link.close(); } catch (e) { /* ignore */ } this.pending.delete(id); }
    try {
      const offers = await this.signaling.take(this.lobby.id, ['offer']);
      for (const row of offers) this._answerOffer(row).catch((e) => console.warn('HostServer: offer failed', e));
    } catch (e) { /* offline: try again */ } finally { this.polling = false; }
  }

  async _answerOffer(row) {
    const userId = row.from_user;
    if (row.created_at && Date.now() - Date.parse(row.created_at) > 20000) return; // a guest that gave up long ago
    const attempt = (row.payload && row.payload.attempt) || null;
    const stale = this.pending.get(userId);
    if (stale) {
      // The same offer seen twice (polling races) is already being answered. A *new* attempt from a guest whose
      // last one never finished replaces it: an ICE failure can take 30 s to surface, so the old link is dropped
      // at once (a connected link keeps the new offer out: it is still negotiating).
      if (stale.attempt === attempt || (stale.link && stale.link.open)) return;
      try { stale.link && stale.link.close(); } catch (e) { /* ignore */ }
      this.pending.delete(userId);
    }
    const peer = { userId, name: null, link: null, ready: false, state: null, stateTime: 0, mode: 'survival', held: 0, armor: null, remote: null, lastHit: 0, lastHurt: 0, health: 100, since: performance.now(), attempt };
    this.pending.set(userId, peer);
    peer.link = new PeerLink({
      iceServers: [],
      onMessage: (msg, channel) => this._onMessage(peer, msg, channel),
      onClose: (reason) => this._peerClosed(peer, reason),
    });
    console.info(`CraftOn net: answering an offer from ${userId.slice(0, 8)} (attempt ${attempt || '-'})`);
    const sdp = await peer.link.createAnswer(row.payload.sdp);
    await this.signaling.send(this.lobby.id, userId, 'answer', { sdp, attempt: row.payload.attempt || null });
  }

  _onMessage(peer, msg, channel) {
    switch (msg.t) {
      case Msg.HELLO: return this._hello(peer, msg);
      case Msg.P: return this._playerState(peer, msg);
      case Msg.BLOCK: return this._blockRequest(peer, msg);
      case Msg.ATTACK: return this._attack(peer, msg);
      case Msg.PICKUP: return this._pickup(peer, msg);
      case Msg.THROW: return this._throw(peer, msg);
      case Msg.META: return this._meta(peer, msg);
      case Msg.SWING: if (peer.remote) peer.remote.swing(); return this.broadcast(Msg.SWING, { id: peer.userId }, peer);
      case Msg.MINING: if (peer.remote) { if (msg.stop) peer.remote.miningStop(); else peer.remote.mining(msg.x, msg.y, msg.z, msg.p); } return this.broadcast(Msg.MINING, { ...msg, id: peer.userId }, peer);
      case Msg.SOUND: this.game.audio.playAt(msg.name, msg.x, msg.y, msg.z, 'blocks', msg.vol || 0.8); return this.broadcast(Msg.SOUND, { ...msg, id: peer.userId }, peer);
      case Msg.INV: return this._storeGuest(peer, msg);
      case Msg.HIT: return this._hit(peer, msg);
      case Msg.HEALTH: return this._health(peer, msg);
      case Msg.DEATH: return this._death(peer, msg);
      case Msg.BYE: return this._peerClosed(peer, 'left');
      default: return undefined;
    }
  }

  async _hello(peer, msg) {
    const reject = (reason) => { peer.link.send(Msg.REJECT, { reason }); setTimeout(() => peer.link.close(), 300); this.pending.delete(peer.userId); };
    if (msg.version !== GAME_VERSION) return reject(RejectReason.VERSION);
    if (this.peers.size + 1 >= this.maxPlayers) return reject(RejectReason.FULL);
    if (msg.userId === this.userId || this.peers.has(msg.userId) || msg.userId !== peer.userId) return reject(RejectReason.DUPLICATE);
    peer.name = String(msg.name || 'player').slice(0, 16);
    peer.ready = true;
    this.pending.delete(peer.userId);
    this.peers.set(peer.userId, peer);
    peer.remote = this.remote.add(peer.userId, peer.name);
    const g = this.game;
    const meta = g.worldMeta;
    const saved = meta.guests[peer.userId] || null;
    // Game mode permissions (Update #9 §1): a returning guest gets its saved mode, a new one the default mode;
    // "Can change own game mode" is off unless the host turned it on in Server Settings.
    const row = this._guestRow(peer.userId);
    row.name = peer.name;
    peer.mode = MODES.includes(row.mode) ? row.mode : this.defaultMode;
    peer.canChangeMode = !!row.canChangeMode;
    const { batches, count } = await encodeChunkBatches(g.world.edits);
    const players = [this._playerRow(this.userId, this.name, encodePlayerState(g.player), this._ownMeta())];
    for (const other of this.peers.values()) if (other !== peer && other.state) players.push(this._playerRow(other.userId, other.name, other.state, { held: other.held, armor: other.armor, mode: other.mode }));
    peer.link.send(Msg.WELCOME, {
      seed: g.world.seed, worldName: meta.name, gameMode: meta.gameMode, version: GAME_VERSION, hostId: this.userId, hostName: this.name,
      spawn: { x: g.player.spawn.x, y: g.player.spawn.y, z: g.player.spawn.z },
      you: { player: saved ? saved.player : null, inventory: saved ? saved.inventory : null, mode: peer.mode, canChangeMode: peer.canChangeMode },
      keepInventory: !!meta.keepInventory, pvp: meta.pvp !== false,
      players, mobs: g.entities.mobs.mobs.filter((m) => !m.isDying).map((m) => this._mobRow(m)), items: g.entities.items.map((it) => this._itemRow(it)), chunkCount: count,
    });
    for (let i = 0; i < batches.length; i++) {
      while (peer.link.bufferedAmount > CHUNK_SEND_HIGH_WATER && peer.link.open) await new Promise((r) => setTimeout(r, 20));
      if (!peer.link.open) return;
      peer.link.send(Msg.CHUNKS, { rows: batches[i], done: i === batches.length - 1 });
    }
    this.broadcast(Msg.JOIN, { id: peer.userId, name: peer.name }, peer);
    g.ui.hud.showToast(`${peer.name} joined`, false);
    this._heartbeat();
  }

  _playerRow(id, name, state, meta) { return { id, name, state, held: meta.held, armor: meta.armor, mode: meta.mode }; }

  _playerState(peer, msg) {
    if (!peer.ready || !Array.isArray(msg.s)) return;
    const s = msg.s;
    const now = performance.now() / 1000;
    // Light sanity checks: no teleports, no flying in Survival.
    if (peer.state) {
      const d = Math.hypot(s[0] - peer.state[0], s[1] - peer.state[1], s[2] - peer.state[2]);
      if (d > MAX_MOVE_PER_SNAPSHOT) return;
    }
    if (peer.mode === 'survival' && (s[8] & Pose.FLYING)) s[8] &= ~Pose.FLYING;
    peer.state = s;
    peer.stateTime = now;
    if (peer.remote) peer.remote.snapshot(now, s);
  }

  _blockRequest(peer, msg) {
    const g = this.game;
    const { x, y, z, id, seq } = msg;
    // `reason` names the real reasons ('far', 'entity'); a stale or malformed request rejects silently.
    const reject = (reason = null) => peer.link.send(Msg.BLOCK_REJECT, { seq, x, y, z, id: g.world.getBlock(x, y, z), reason });
    if (!peer.state || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !Number.isInteger(id)) return reject();
    const dist = Math.hypot(x + 0.5 - peer.state[0], y + 0.5 - (peer.state[1] + 1.6), z + 0.5 - peer.state[2]);
    if (dist > REACH_CREATIVE + 2.5) return reject('far');
    if (!g.world.isLoadedAt(x, z)) return reject();
    const cur = g.world.getBlock(x, y, z);
    const creative = peer.mode === 'creative';
    if (id === 0) {
      if (cur === 0) return reject();
      if (!creative && !isFinite(BREAK_TIME[cur])) return reject(); // bedrock stays in Survival
    } else {
      if (!BlockRegistry.get(id)) return reject();
      if (!BlockRegistry.isReplaceable(cur)) return reject();
      if (NEEDS_SUPPORT[id] === 1 && !g.world.isSolid(x, y - 1, z)) return reject();
      // Never inside anyone: the host, any other player (raw snapshots) or a mob.
      if (SOLID[id] === 1 && (g.player.aabb.intersectsBox(x, y, z, x + 1, y + 1, z + 1) || this._playerBlocksAt(x, y, z, peer) || mobBlocksAt(g.entities.mobs.mobs, x, y, z))) return reject('entity');
    }
    this.applyingFor = { by: peer.userId };
    try {
      if (id === 0) {
        g.world.setBlock(x, y, z, 0);
        g.audio.playBlock('break', cur, x + 0.5, y + 0.5, z + 0.5);
        g.particles.spawnBlockBreak(x, y, z, cur, 12);
        if (!creative) { // the host drops the item (guests never spawn drops themselves)
          const dropName = BlockRegistry.dropName(cur);
          const drop = dropName ? ItemRegistry.idOf(dropName) : -1;
          if (drop >= 0 && Math.random() < BlockRegistry.dropChance(cur)) g.entities.spawnItem(x + 0.5, y + 0.3, z + 0.5, drop, 1);
        }
        const above = g.world.getBlock(x, y + 1, z);
        if (above !== 0 && NEEDS_SUPPORT[above] === 1) g.interaction.breakBlock(x, y + 1, z);
      } else {
        g.world.setBlock(x, y, z, id);
        g.audio.playBlock('place', id, x + 0.5, y + 0.5, z + 0.5);
      }
    } finally { this.applyingFor = null; }
  }

  /** True when any connected player (the requester included) stands in block (x, y, z), from the latest snapshots. */
  _playerBlocksAt(x, y, z) {
    for (const other of this.peers.values()) {
      const s = other.state;
      if (!s || (s[8] & Pose.SPECTATOR)) continue;
      if (playerBlocksAt(x, y, z, s[0], s[1], s[2], playerHeightForPose(s[8]))) return true;
    }
    return false;
  }

  // ---- Player vs player (Update #9 §8): the host validates every hit ----

  get pvp() { const m = this.game.worldMeta; return !m || m.pvp !== false; }

  /** Armor points of a connected peer from its replicated armor materials. */
  _peerArmorPoints(peer) {
    if (!peer.armor) return 0;
    let n = 0;
    for (const [slot, material] of Object.entries(peer.armor)) { const pts = material && ARMOR_POINTS[material]; if (pts && pts[slot]) n += pts[slot]; }
    return n;
  }

  /** A guest hit someone (HIT { target, crit }). */
  _hit(peer, msg) {
    if (!peer.state) return;
    this._applyHit({ id: peer.userId, name: peer.name, held: peer.held, mode: peer.mode, x: peer.state[0], y: peer.state[1], z: peer.state[2], peer }, String(msg.target || ''), !!msg.crit);
  }

  /** The host hit a guest (BlockInteraction 'player:hitPlayer'). */
  hitPlayer(targetId, crit) {
    const g = this.game, p = g.player;
    const held = g.inventory.getSelected();
    this._applyHit({ id: this.userId, name: this.name, held: held ? held.itemId : 0, mode: p.gameMode, x: p.position.x, y: p.position.y, z: p.position.z, peer: null }, targetId, crit);
  }

  /** Reach, cooldown, modes and the PvP toggle, then the damage goes to the victim and everyone sees the hit. */
  _applyHit(att, targetId, crit) {
    const g = this.game;
    if (!this.pvp || att.mode === 'spectator') return;
    const now = performance.now() / 1000;
    const attPeer = att.peer || this;
    if (now - (attPeer.lastHit || 0) < 0.45) return;
    let vx, vy, vz, vMode, vPoints, victimPeer = null;
    if (targetId === this.userId) { const p = g.player; vx = p.position.x; vy = p.position.y; vz = p.position.z; vMode = p.gameMode; vPoints = g.inventory.armorPoints(); }
    else { victimPeer = this.peers.get(targetId); if (!victimPeer || !victimPeer.state) return; vx = victimPeer.state[0]; vy = victimPeer.state[1]; vz = victimPeer.state[2]; vMode = victimPeer.mode; vPoints = this._peerArmorPoints(victimPeer); }
    if (vMode !== 'survival') return;
    const victim = victimPeer || this;
    if (now - (victim.lastHurt || 0) < 0.45) return;
    const dist = Math.hypot(vx - att.x, vy + 0.9 - (att.y + 1.6), vz - att.z);
    if (dist > PVP_REACH + PVP_REACH_SLACK) return;
    attPeer.lastHit = now; victim.lastHurt = now;
    const n = pvpDamage(attackDamage(att.held), crit, vPoints);
    const dx = vx - att.x, dz = vz - att.z, len = Math.hypot(dx, dz) || 1;
    const kx = dx / len, kz = dz / len;
    if (victimPeer) {
      victimPeer.link.send(Msg.DAMAGE, { n, by: att.name, kx, kz, crit });
      if (victimPeer.remote) victimPeer.remote.hurt(crit, n);
    } else g.health.damage(n, { kind: 'pvp', by: att.name }, { kx, kz, crit, ignoreInvuln: true });
    this.broadcast(Msg.HURT, { id: targetId, crit, n }, victimPeer);
  }

  /** A guest reports its health (after fall damage: others see the flash). */
  _health(peer, msg) {
    const hp = Math.max(0, Math.min(100, Number(msg.hp) || 0));
    peer.health = hp;
    this._guestRow(peer.userId).health = hp;
    if (msg.hurt) { if (peer.remote) peer.remote.hurt(false, 0); this.broadcast(Msg.HURT, { id: peer.userId, crit: false, n: 0 }, peer); }
  }

  /** A guest died: everyone else gets the message. */
  _death(peer, msg) {
    const text = deathMessage(peer.name, msg.cause);
    this.game.ui.hud.showToast(text, false);
    this.broadcast(Msg.DEATH, { id: peer.userId, text }, peer);
  }

  /** The host died: tell the guests. */
  announceOwnDeath(cause) { this.broadcast(Msg.DEATH, { id: this.userId, text: deathMessage(this.name, cause) }); }

  /** PvP / keep inventory changed in Server Settings: guests follow. */
  broadcastWorldSettings() { const m = this.game.worldMeta; this.broadcast(Msg.WORLD, { keepInventory: !!(m && m.keepInventory), pvp: !m || m.pvp !== false }); }

  _attack(peer, msg) {
    const mobs = this.game.entities.mobs;
    const mob = mobs.byId.get(msg.id);
    if (!mob || !peer.state) return;
    const d = Math.hypot(mob.position.x - peer.state[0], mob.position.z - peer.state[2]);
    if (d > 6) return;
    const damage = Math.max(1, Math.min(10, Number(msg.damage) || 1));
    mobs.hit(mob, damage, peer.state[0], peer.state[2], !!msg.crit);
  }

  _pickup(peer, msg) {
    const items = this.game.entities;
    const it = items.byId.get(msg.id);
    if (!it || it.dead || !peer.state) return;
    const px = peer.state[0], py = peer.state[1], pz = peer.state[2];
    const hw = PLAYER_WIDTH / 2 + ITEM_PICKUP_EXPAND_XZ + 0.5;
    const p = it.position;
    const inside = p.x + ITEM_HALF > px - hw && p.x - ITEM_HALF < px + hw && p.y + ITEM_HALF > py - ITEM_PICKUP_EXPAND_Y - 0.5 && p.y - ITEM_HALF < py + PLAYER_HEIGHT + ITEM_PICKUP_EXPAND_Y + 0.5 && p.z + ITEM_HALF > pz - hw && p.z - ITEM_HALF < pz + hw;
    if (!inside) return;
    const n = it.count;
    items.removeEntity(it);
    peer.link.send(Msg.ITEM_GRANT, { item: it.itemId, n });
  }

  _throw(peer, msg) {
    if (!peer.state || !ItemRegistry.has(msg.item) || !(msg.n > 0)) return;
    this.game.entities.spawnItem(msg.x, msg.y, msg.z, msg.item, Math.min(64, msg.n | 0), msg.vx, msg.vy, msg.vz, 1.5);
  }

  _meta(peer, msg) {
    if (msg.held !== undefined) peer.held = msg.held;
    if (msg.armor !== undefined) peer.armor = msg.armor;
    if (msg.mode && msg.mode !== peer.mode) {
      // The host validates mode changes: without permission the guest is told its real mode again.
      if (!peer.canChangeMode || !MODES.includes(msg.mode)) { peer.link.send(Msg.MODE, { mode: peer.mode, canChange: !!peer.canChangeMode }); delete msg.mode; }
      else { peer.mode = msg.mode; this._guestRow(peer.userId).mode = msg.mode; this.game.session.changedSinceSave = true; }
    }
    if (peer.remote) peer.remote.setMeta(msg);
    this.broadcast(Msg.META, { ...msg, id: peer.userId }, peer);
  }

  _storeGuest(peer, msg) {
    const meta = this.game.worldMeta;
    if (!meta) return;
    meta.guests[peer.userId] = { name: peer.name, player: msg.player || null, inventory: msg.inventory || null, lastSeen: Date.now(), mode: peer.mode || this.defaultMode, canChangeMode: !!peer.canChangeMode };
    this.game.session.changedSinceSave = true;
  }

  // ---- Game mode permissions (Update #9 §1): the host decides every guest's mode -------------------------

  /** Mode new guests start in: meta.defaultGameMode (Server Settings), else the world's own mode. */
  get defaultMode() { const meta = this.game.worldMeta; return (meta && MODES.includes(meta.defaultGameMode) && meta.defaultGameMode) || (meta && meta.gameMode) || 'survival'; }

  setDefaultMode(mode) {
    const meta = this.game.worldMeta;
    if (!meta || !MODES.includes(mode)) return;
    meta.defaultGameMode = mode;
    this.game.session.changedSinceSave = true;
  }

  /** The saved row of a guest (created with the default mode and no permission). */
  _guestRow(userId) {
    const meta = this.game.worldMeta;
    if (!meta.guests[userId]) meta.guests[userId] = { name: '', player: null, inventory: null, lastSeen: Date.now(), mode: this.defaultMode, canChangeMode: false };
    return meta.guests[userId];
  }

  /** Everyone the server knows for the Server Settings screen: connected players first, then saved guests. */
  guestRows() {
    const meta = this.game.worldMeta;
    const rows = [], seen = new Set();
    for (const p of this.peers.values()) { seen.add(p.userId); rows.push({ userId: p.userId, name: p.name, mode: p.mode, canChangeMode: !!p.canChangeMode, online: true }); }
    for (const [id, gst] of Object.entries(meta ? meta.guests : {})) {
      if (seen.has(id)) continue;
      rows.push({ userId: id, name: gst.name || id.slice(0, 8), mode: MODES.includes(gst.mode) ? gst.mode : this.defaultMode, canChangeMode: !!gst.canChangeMode, online: false });
    }
    return rows;
  }

  /** Host sets a guest's mode (saved; a connected guest switches at once and everyone sees the new mode). */
  setGuestMode(userId, mode) {
    if (!MODES.includes(mode)) return;
    this._guestRow(userId).mode = mode;
    this.game.session.changedSinceSave = true;
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.mode = mode;
    if (peer.remote) peer.remote.setMeta({ mode });
    peer.link.send(Msg.MODE, { mode, canChange: !!peer.canChangeMode });
    this.broadcast(Msg.META, { mode, id: peer.userId }, peer);
  }

  /** Host toggles "Can change own game mode" for a guest (saved; a connected guest learns about it at once). */
  setGuestCanChange(userId, allowed) {
    this._guestRow(userId).canChangeMode = !!allowed;
    this.game.session.changedSinceSave = true;
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.canChangeMode = !!allowed;
    peer.link.send(Msg.MODE, { mode: peer.mode, canChange: peer.canChangeMode });
  }

  _peerClosed(peer, reason) {
    if (this.peers.has(peer.userId)) console.info(`CraftOn net: ${peer.name || peer.userId} left (${reason})`);
    const wasIn = this.peers.delete(peer.userId);
    this.pending.delete(peer.userId);
    try { peer.link.close(); } catch (e) { /* ignore */ }
    if (!wasIn) return;
    if (peer.remote) { this.remote.remove(peer.userId); peer.remote = null; }
    this.broadcast(Msg.LEAVE, { id: peer.userId });
    if (this.running) this.game.ui.hud.showToast(`${peer.name || 'A player'} left`, false);
    this._heartbeat();
  }

  /** Send to every ready guest (optionally all but one) on the reliable channel. */
  broadcast(type, fields, except = null, channel = 'reliable') {
    for (const p of this.peers.values()) if (p !== except && p.ready) p.link.send(type, fields, channel);
  }

  /** Per frame: flush block changes, send snapshots, drive the remote players. */
  update(dt) {
    if (!this.running) return;
    if (this.blockQueue.length && this.peers.size) { this.broadcast(Msg.BLOCKS, { list: this.blockQueue }); }
    this.blockQueue.length = 0;
    if (!this.peers.size) return;
    this.snapTimer += dt;
    if (this.snapTimer >= 1 / PLAYER_SNAPSHOT_HZ) {
      this.snapTimer = 0;
      const list = [[this.userId, ...encodePlayerState(this.game.player)]];
      for (const p of this.peers.values()) if (p.state) list.push([p.userId, ...p.state]);
      this.broadcast(Msg.PS, { list }, null, 'state');
    }
    this.mobTimer += dt;
    if (this.mobTimer >= 1 / MOB_SNAPSHOT_HZ) {
      this.mobTimer = 0;
      const mobs = this.game.entities.mobs.mobs.filter((m) => !m.frozen).map((m) => [m.id, +m.position.x.toFixed(3), +m.position.y.toFixed(3), +m.position.z.toFixed(3), +m.yaw.toFixed(3), +m.headYaw.toFixed(3), +m.velocity.x.toFixed(2), +m.velocity.z.toFixed(2)]);
      const items = this.game.entities.items.map((it) => [it.id, +it.position.x.toFixed(3), +it.position.y.toFixed(3), +it.position.z.toFixed(3)]);
      this.broadcast(Msg.M, { mobs, items }, null, 'state');
    }
  }

  /** Stop hosting: tell the guests, close every link, delete the lobby. The host keeps playing alone. */
  stop(reason = 'stopped') {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    window.removeEventListener('pagehide', this._pagehide);
    this.broadcast(Msg.HOST_CLOSED, { reason });
    for (const p of [...this.peers.values(), ...this.pending.values()]) { try { p.link.close(); } catch (e) { /* ignore */ } }
    this.peers.clear(); this.pending.clear();
    this.remote.clear();
    this._unwire();
    const g = this.game;
    if (this.lobby) {
      const id = this.lobby.id;
      const del = () => { try { g.cloud.from('lobbies').delete().eq('id', id).then(() => {}, () => {}); } catch (e) { /* best effort */ } };
      del(); setTimeout(del, 1200); // a heartbeat still in flight (or another tab's write) could bring the row back
      this.signaling.clear(id);
    }
    this.lobby = null;
  }
}
