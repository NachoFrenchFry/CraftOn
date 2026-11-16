// HostServer.js — the host's game tab is the server: it publishes a lobby row (plain REST), answers
// WebRTC offers found by polling the signals table, and runs the authoritative world for every guest: blocks
// (guest requests are validated — reach, game mode, block rules — then broadcast, or rejected so the guest
// reverts), the water simulation, mobs (AI, health, death, drops), dropped items and pickups (granted to exactly
// one player), and time. Each player owns their own movement (light sanity checks) and inventory; guests' player
// data is stored in the host's world save under `guests[userId]`. Snapshots of every player go out at 20 Hz and
// of mobs / items at 12 Hz on the unreliable state channel; everything else on the reliable channel.
// the lobby is Public (listed for everyone) or Private (same network or by code), every link uses the
// STUN + TURN servers from IceServers.js, and the host can Kick or Ban players (bans live in the world save as
// meta.bans[userId]; a banned account is refused at the signaling step, before any WebRTC negotiation).
// `lan` mode (Nov 10 2026, the world's Same Wi-Fi multiplayer setting, started by Game right after the world loads): a
// Private lobby for up to 8 players, STUN only (no relay credentials are fetched), offers polled every 2 s, and the game
// keeps its single-player feel until someone joins (Game._netChanged: the pause menu pauses, the hidden-tab ticker and the
// pause overlay only with a guest connected). Never uses Supabase Realtime.

import { PeerLink } from './PeerLink.js';
import { getIceServers, stunOnlyIceServers } from './IceServers.js';
import { worldSettingsMessage, lockedText, NO_CHEATS_TEXT } from '../core/WorldSettings.js';
import { playerBlocksAt, playerHeightForPose, mobBlocksAt } from '../player/PlacementRules.js';
import { pvpDamage, PVP_REACH, PVP_REACH_SLACK, deathMessage, zombieDamage, arrowPlayerDamage, explosionPlayerDamage, maceClosingSpeed, macePlayerDamage, isMaceSmash, spearClosingSpeed, spearPlayerDamage, isSpearFast, horizontalDir, SPEAR_VELOCITY_CLAMP } from '../player/Damage.js';
import { cleanChatText } from '../ui/Chat.js';

/** Chat rate limit per guest: at most this many messages per window. */
const CHAT_LIMIT = 5;
const CHAT_WINDOW_MS = 5000;
import { attackDamage, isMace, isSpear } from '../items/Tools.js';
import { armorValueFor, ItemIds } from '../items/ItemDefinitions.js';
import { ItemStack } from '../items/ItemStack.js';
import { MOB_BY_TYPE } from '../entities/mobs/MobSpawner.js';
import { clickSlot, putIntoSlot } from '../items/SlotClick.js';
import { Signaling } from './Signaling.js';
import { detectNetworkHash } from './NetworkId.js';
import { RemotePlayerManager } from './RemotePlayer.js';
import { Msg, RejectReason, MAX_PLAYERS_DEFAULT, VISIBILITIES, PLAYER_SNAPSHOT_HZ, MOB_SNAPSHOT_HZ, encodePlayerState, decodePlayerState, encodeChunkBatches, makeJoinCode, Pose } from './Protocol.js';
import { BlockRegistry, BREAK_TIME, SOLID } from '../blocks/BlockRegistry.js';
import { isSupported, breakDependents } from '../blocks/Support.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { isWater, isLiquid } from '../world/WaterLevels.js';
import { REACH_CREATIVE, ITEM_PICKUP_EXPAND_XZ, ITEM_PICKUP_EXPAND_Y, PLAYER_WIDTH, PLAYER_HEIGHT, EXPLOSION_KNOCKBACK, TERMINAL_VELOCITY, ROCKET_DASH_COOLDOWN, HAND_ATTACK_DAMAGE } from '../config/Constants.js';
import { ITEM_HALF } from '../entities/ItemEntity.js';
import { BOAT_REACH } from '../entities/BoatManager.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { ITEM_PICKUP_DELAY } from '../config/Constants.js';

const LOBBY_HEARTBEAT_MS = 10000;
const OFFER_POLL_MS = 1000;
const MAX_MOVE_PER_SNAPSHOT = 40;   // blocks: anything faster is treated as a glitch and ignored
/** After this many ignored snapshots in a row the player is snapped back to the last accepted position (never left desynced). */
const MAX_REJECTED_SNAPSHOTS = 3;
/** After a host-side respawn, snapshots that still carry the guest's DEAD bit are ignored for this long (they were sent before SPAWN_AT arrived). */
const RESPAWN_GRACE_SECONDS = 3;
const CHUNK_SEND_HIGH_WATER = 1 << 20;
/** A mace / spear hit's claimed velocity must sit within MACE_VY_SLACK blocks/s of the min / max of the guest's replicated velocities (the same component) of the last MACE_VY_WINDOW seconds. */
const MACE_VY_WINDOW = 0.5;
const MACE_VY_SLACK = 10;

const MODES = ['survival', 'creative', 'spectator'];

export class HostServer {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {{ maxPlayers?: number, visibility?: 'public'|'private', lan?: boolean, turn?: boolean, offerPollMs?: number }} [opts]
   *   `lan`: the world's Same Wi-Fi multiplayer setting opened it (Game.startHosting sets private / 8 / no TURN / 2 s polling)
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.maxPlayers = Math.max(2, Math.min(8, opts.maxPlayers || MAX_PLAYERS_DEFAULT));
    this.visibility = VISIBILITIES.includes(opts.visibility) ? opts.visibility : 'public';
    /** Opened by the Same Wi-Fi multiplayer setting (not Multiplayer → Host): the pause menu line differs, Stop Hosting is hidden, the setting is the switch. */
    this.lanMode = !!opts.lan;
    /** Whether relay credentials are fetched (never in lan mode: same-network links need no TURN). */
    this.useTurn = opts.turn !== false;
    this.offerPollMs = Math.max(250, Number(opts.offerPollMs) || OFFER_POLL_MS);
    /** { iceServers, turn, note } from the last getIceServers() (F3 shows whether a relay is available). */
    this.ice = null;
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
    this.ice = await this._iceServers(); // fetched now; without a relay the game quietly stays STUN-only
    // Without a detectable public address the lobby's network_hash is null: a Private lobby is then reachable by code only.
    const res = await g.cloud.from('lobbies').upsert({
      world_name: String(this.worldName || 'World').slice(0, 32), network_hash: net.hash || null, join_code: this.joinCode,
      player_count: 1, max_players: this.maxPlayers, visibility: this.visibility,
    }, { onConflict: 'host_id' }).select('id, join_code').single();
    if (res.error) throw new Error('publish lobby: ' + (res.error.message || res.error));
    this.lobby = res.data;
    g.worldMeta.guests = g.worldMeta.guests || {};
    this.running = true;
    this.timers.push(setInterval(() => this._heartbeat(), LOBBY_HEARTBEAT_MS));
    this.timers.push(setInterval(() => this._pollOffers(), this.offerPollMs));
    this._wire();
    this._pagehide = () => this.stop('pagehide');
    window.addEventListener('pagehide', this._pagehide);
    return this;
  }

  /** The ICE servers for a link: STUN + TURN from the Edge Function, or STUN only without any request in lan mode. */
  _iceServers() { return this.useTurn ? getIceServers(this.game.cloud, { mock: this.game.cloudMock }) : Promise.resolve(stunOnlyIceServers(this.game.cloudMock)); }

  _wire() {
    const ev = this.game.events;
    const on = (name, fn) => this._unsubs.push(ev.on(name, fn));
    on('block:changed', (x, y, z, info) => {
      const by = this.applyingFor ? this.applyingFor.by : this.userId;
      const kind = this.game.entities.exploding ? 'blast' : isLiquid(info.id) || isLiquid(info.old) ? 'flow' : info.id === 0 ? 'break' : 'place'; // 'blast': no per-block effects on the guests (the EXPLOSION message brings them)
      this.blockQueue.push([x, y, z, info.id, by, kind]);
    });
    on('player:swing', () => this.broadcast(Msg.SWING, { id: this.userId }));
    on('mining:progress', (x, y, z, p) => this.broadcast(Msg.MINING, { id: this.userId, x, y, z, p }));
    on('mining:stop', () => this.broadcast(Msg.MINING, { id: this.userId, stop: true }));
    on('inventory:changed', () => this._sendOwnMeta());
    on('inventory:selected', () => this._sendOwnMeta());
    on('gamemode:changed', () => this._sendOwnMeta());
    on('player:equip', (armor) => { const p = this.game.player.position; this.broadcast(Msg.SOUND, { id: this.userId, name: armor.material === 'wood' ? 'player.equip_wood' : 'player.equip_metal', x: p.x, y: p.y + 1, z: p.z, vol: 0.8 }); });
    on('player:rocketFired', () => { const p = this.game.player.position; this.broadcast(Msg.SOUND, { id: this.userId, name: 'items/rocket_launch', x: p.x, y: p.y + 1, z: p.z, vol: 0.9 }); });
    const mobs = this.game.entities.mobs;
    mobs.onSpawn = (m) => this.broadcast(Msg.MOB_SPAWN, this._mobRow(m));
    mobs.onRemove = (m) => this.broadcast(Msg.MOB_REMOVE, { id: m.id });
    mobs.onHurt = (m, died, crit, fromX, fromZ, kb) => this.broadcast(Msg.MOB_HURT, { id: m.id, health: m.health, fromX, fromZ, crit, died, kb: kb || 1 });
    const items = this.game.entities;
    const boats = this.game.entities.boats;
    if (boats) {
      // Rider ids on the wire are user ids: the host's own 'self' becomes its id while it hosts (and back in _unwire).
      boats.localId = this.userId;
      for (const b of boats.list) { if (b.driver === 'self') b.driver = this.userId; if (b.passenger === 'self') b.passenger = this.userId; }
      boats.onSpawn = (b) => this.broadcast(Msg.BOAT_SPAWN, boats.row(b));
      boats.onRemove = (b) => this.broadcast(Msg.BOAT_REMOVE, { id: b.id });
      boats.onRiders = (b) => this.broadcast(Msg.BOAT_RIDERS, { id: b.id, driver: b.driver, passenger: b.passenger });
    }
    items.onSpawn = (it) => this.broadcast(Msg.ITEM_SPAWN, this._itemRow(it));
    items.onRemove = (it) => this.broadcast(Msg.ITEM_REMOVE, { id: it.id });
    // Arrows and explosives: the host simulates, the guests mirror (spawn with the same velocity, corrections when stuck).
    items.onArrowSpawn = (a) => this.broadcast(Msg.ARROW_SPAWN, { id: a.id, shooter: a.shooter === 'self' ? this.userId : a.shooter, x: a.position.x, y: a.position.y, z: a.position.z, vx: a.velocity.x, vy: a.velocity.y, vz: a.velocity.z, power: a.power, crit: a.crit, pickup: a.pickup });
    items.onArrowStuck = (a) => this.broadcast(Msg.ARROW_STUCK, { id: a.id, x: a.position.x, y: a.position.y, z: a.position.z });
    items.onArrowRemove = (a) => this.broadcast(Msg.ARROW_REMOVE, { id: a.id });
    items.onArrowPickup = (a) => this._arrowPickup(a);
    items.onExplosiveSpawn = (e) => this.broadcast(Msg.EXPLOSIVE_SPAWN, { id: e.id, x: e.position.x, y: e.position.y, z: e.position.z, vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z, fuse: e.fuse });
    items.onExplosion = (e, x, y, z, power) => this.broadcast(Msg.EXPLOSION, { id: e.id, x, y, z, power });
    // Chests: every change of the host's (authoritative) contents goes to everyone as the changed slot.
    this.game.chests.onSlotChanged = (x, y, z, slot, st) => {
      if (slot >= 0) this.broadcast(Msg.CHEST_SLOT, { x, y, z, slot, stack: st.get(slot) ? st.get(slot).serialize() : null });
      else this.broadcast(Msg.CHEST_SLOT, { x, y, z, slot: -1, slots: st.serialize() });
    };
  }

  _unwire() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    const mobs = this.game.entities.mobs; if (mobs) { mobs.onSpawn = null; mobs.onRemove = null; mobs.onHurt = null; }
    const items = this.game.entities; items.onSpawn = null; items.onRemove = null;
    const boats = this.game.entities.boats;
    if (boats) {
      boats.onSpawn = null; boats.onRemove = null; boats.onRiders = null;
      for (const b of boats.list) { // the guests are gone: only the host keeps its seat (as 'self' again); every boat is the host's to simulate
        const mine = b.driver === this.userId ? 0 : b.passenger === this.userId ? 1 : -1;
        b.driver = mine >= 0 ? 'self' : null; b.passenger = null;
        b.remote = false; b.lastState = null; b.interp.reset();
        if (mine === 1) this.game.player.seat = 0;
      }
      boats.localId = 'self';
    }
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
    if (this.isBanned(userId)) { // refused before any negotiation: the guest's wait ends with the reason
      console.info(`CraftOn net: refusing a banned account ${userId.slice(0, 8)}`);
      await this.signaling.send(this.lobby.id, userId, 'reject', { reason: RejectReason.BANNED, attempt });
      return;
    }
    const stale = this.pending.get(userId);
    if (stale) {
      // The same offer seen twice (polling races) is already being answered. A *new* attempt from a guest whose
      // last one never finished replaces it: an ICE failure can take 30 s to surface, so the old link is dropped
      // at once (a connected link keeps the new offer out: it is still negotiating).
      if (stale.attempt === attempt || (stale.link && stale.link.open)) return;
      try { stale.link && stale.link.close(); } catch (e) { /* ignore */ }
      this.pending.delete(userId);
    }
    const peer = { userId, name: null, link: null, ready: false, state: null, stateTime: 0, mode: 'survival', held: 0, armor: null, remote: null, lastHit: 0, lastHurt: 0, health: 100, since: performance.now(), attempt, kicked: null, dead: false, rejected: 0, vyHistory: [] };
    this.pending.set(userId, peer);
    const ice = await this._iceServers(); // cached; refreshed before the credentials expire
    this.ice = ice;
    peer.link = new PeerLink({
      iceServers: ice.iceServers,
      onMessage: (msg, channel) => this._onMessage(peer, msg, channel),
      onClose: (reason) => this._peerClosed(peer, reason),
    });
    console.info(`CraftOn net: answering an offer from ${userId.slice(0, 8)} (attempt ${attempt || '-'})`);
    const sdp = await peer.link.createAnswer(row.payload.sdp);
    await this.signaling.send(this.lobby.id, userId, 'answer', { sdp, attempt: row.payload.attempt || null });
  }

  _onMessage(peer, msg, channel) {
    if (!msg || typeof msg.t !== 'string') return; // malformed: ignored
    switch (msg.t) {
      case Msg.HELLO: return this._hello(peer, msg);
      case Msg.P: return this._playerState(peer, msg);
      case Msg.BLOCK: return this._blockRequest(peer, msg);
      case Msg.ATTACK: return this._attack(peer, msg);
      case Msg.SHOOT: return this._shoot(peer, msg);
      case Msg.ROCKET: return this._rocket(peer);
      case Msg.ROCKET_DASH: return this._rocketDash(peer);
      case Msg.SPAWN_EGG: return this._spawnEgg(peer, msg);
      case Msg.CHEST_OPEN: return this._chestOpen(peer, msg);
      case Msg.CHEST_OP: return this._chestOp(peer, msg);
      case Msg.PRIME: return this._prime(peer, msg);
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
      case Msg.RESPAWN: return this._respawn(peer, msg);
      case Msg.CHAT: return this._chat(peer, msg);
      case Msg.COMMAND: return this._command(peer, msg);
      case Msg.BOAT_PLACE: return this._boatPlace(peer, msg);
      case Msg.BOAT_ENTER: return this._boatEnter(peer, msg);
      case Msg.BOAT_LEAVE: return this._boatLeave(peer);
      case Msg.BOAT_BREAK: return this._boatBreak(peer, msg);
      case Msg.TICK: return; // only the host sets the rate
      case Msg.BYE: return this._peerClosed(peer, 'left');
      default: return undefined;
    }
  }

  async _hello(peer, msg) {
    const reject = (reason) => { peer.link.send(Msg.REJECT, { reason }); setTimeout(() => peer.link.close(), 300); this.pending.delete(peer.userId); };
    if (typeof msg.userId !== 'string' || !msg.userId) return reject(RejectReason.DUPLICATE);
    if (this.isBanned(msg.userId) || this.isBanned(peer.userId)) return reject(RejectReason.BANNED);
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
    // Game mode permissions: a returning guest gets its saved mode, a new one the default mode;
    // "Can change own game mode" is off unless the host turned it on in Server Settings.
    const row = this._guestRow(peer.userId);
    row.name = peer.name;
    // A locked world holds everyone to its mode (saved guest data that says otherwise included) and, locked to Survival, allows no cheats.
    const locked = this.game.lockedMode;
    peer.mode = locked || (MODES.includes(row.mode) ? row.mode : this.defaultMode);
    peer.canChangeMode = locked === 'survival' ? false : !!row.canChangeMode;
    const { batches, count } = await encodeChunkBatches(g.world.edits);
    const players = [this._playerRow(this.userId, this.name, encodePlayerState(g.player), this._ownMeta())];
    for (const other of this.peers.values()) if (other !== peer && other.state) players.push(this._playerRow(other.userId, other.name, other.state, { held: other.held, armor: other.armor, mode: other.mode }));
    peer.link.send(Msg.WELCOME, {
      seed: g.world.seed, seedText: meta.seedText || '', worldName: meta.name, gameMode: meta.gameMode, hostId: this.userId, hostName: this.name,
      tick: { rate: g.tick.rate, frozen: g.tick.frozen },
      spawn: { x: g.player.spawn.x, y: g.player.spawn.y, z: g.player.spawn.z },
      you: { player: saved ? saved.player : null, inventory: saved ? saved.inventory : null, mode: peer.mode, canChangeMode: peer.canChangeMode },
      ...worldSettingsMessage(meta), // keep inventory, PvP, hostile mobs, explosives, fall damage, natural spawning, and the world type + Superflat layers (set before any chunk generates)
      players, mobs: g.entities.mobs.mobs.filter((m) => !m.isDying).map((m) => this._mobRow(m)), items: g.entities.items.map((it) => this._itemRow(it)), chunkCount: count,
      boats: g.entities.boats ? g.entities.boats.list.map((b) => g.entities.boats.row(b)) : [], // every boat and who sits in it (Nov 15 2026)
    });
    // The chunk rows go over the reliable channel, which carried the HELLO: `link.open` (both channels) may still be false here
    // when the state channel is a moment behind, and waiting for it used to drop the download — the guest then sat at
    // "Downloading world…" forever (fixed Nov 11 2026).
    for (let i = 0; i < batches.length; i++) {
      while (peer.link.bufferedAmount > CHUNK_SEND_HIGH_WATER && peer.link.reliableOpen) await new Promise((r) => setTimeout(r, 20));
      if (!peer.link.reliableOpen) return;
      peer.link.send(Msg.CHUNKS, { rows: batches[i], done: i === batches.length - 1 });
    }
    this.broadcast(Msg.JOIN, { id: peer.userId, name: peer.name }, peer);
    g.systemChat(`${peer.name} joined the game`, 'yellow');
    this._heartbeat();
    g._netChanged(); // a guest is connected: the pause menu becomes an overlay (lan mode), the player count updates
  }

  _playerRow(id, name, state, meta) { return { id, name, state, held: meta.held, armor: meta.armor, mode: meta.mode }; }

  _playerState(peer, msg) {
    if (!peer.ready || !Array.isArray(msg.s)) return;
    const s = msg.s;
    const now = performance.now() / 1000;
    // Light sanity checks: no teleports (a legitimate jump — respawn, the void, a teleport — goes through RESPAWN /
    // SPAWN_AT and resets the baseline), no flying in Survival. A player whose snapshots keep failing is snapped back
    // to the last accepted position instead of being ignored forever.
    if (peer.state) {
      const d = Math.hypot(s[0] - peer.state[0], s[1] - peer.state[1], s[2] - peer.state[2]);
      if (d > MAX_MOVE_PER_SNAPSHOT) { if (++peer.rejected >= MAX_REJECTED_SNAPSHOTS) this._correct(peer); return; }
    }
    peer.rejected = 0;
    if (peer.mode === 'survival' && (s[8] & Pose.FLYING)) s[8] &= ~Pose.FLYING;
    // The guest's own DEAD bit counts (its DEATH may still be in flight), except right after the host respawned it: a
    // snapshot sent before the guest saw SPAWN_AT still carries the bit and must not kill it again.
    if ((s[8] & Pose.DEAD) && now - (peer.respawnedAt || -Infinity) > RESPAWN_GRACE_SECONDS) peer.dead = true;
    if (peer.dead) s[8] |= Pose.DEAD; else s[8] &= ~Pose.DEAD; // only the host's respawn clears it
    peer.state = s;
    peer.stateTime = now;
    this._trackChunk(peer);
    // The guest's recent velocities [t, vx, vy, vz]: a mace / spear hit's claimed velocity is checked against them.
    const h = peer.vyHistory || (peer.vyHistory = []);
    h.push([now, Number(s[3]) || 0, Number(s[4]) || 0, Number(s[5]) || 0]);
    while (h.length && now - h[0][0] > MACE_VY_WINDOW * 2) h.shift();
    if (peer.remote) peer.remote.snapshot(now, s);
    if (Array.isArray(msg.b)) this._boatState(peer, msg.b); // a driving guest's boat travels with its snapshot
  }

  // ---- boats (Nov 15 2026): the host owns the list and the seats; the driver's machine moves its boat ----

  /** A driving guest's boat state [id, x, y, z, vx, vy, vz, yaw]: only from that boat's current driver, no jumps; mirrored here and relayed in PS. */
  _boatState(peer, b) {
    const boats = this.game.entities.boats;
    const boat = boats && boats.byId.get(b[0]);
    if (!boat || boat.driver !== peer.userId || b.length < 8) return;
    if (boat.lastState && Math.hypot(b[1] - boat.lastState[1], b[2] - boat.lastState[2], b[3] - boat.lastState[3]) > MAX_MOVE_PER_SNAPSHOT) return;
    boat.lastState = b;
    boat.applyRemote(performance.now() / 1000, b);
  }

  /** BOAT_PLACE: a boat from the guest's inventory (its replicated inventory in Survival), in reach and in free space. */
  _boatPlace(peer, msg) {
    const g = this.game, boats = g.entities.boats;
    if (!boats || !peer.state || peer.dead) return;
    const x = +msg.x, y = +msg.y, z = +msg.z, yaw = +msg.yaw || 0;
    if (![x, y, z].every(Number.isFinite)) return;
    if (Math.hypot(x - peer.state[0], z - peer.state[2]) > REACH_CREATIVE + 3) return;
    if (peer.mode !== 'creative' && !this._peerHasItem(peer, ItemIds.BOAT)) return;
    if (!boats.canPlaceAt(x, y, z)) return;
    boats.spawn(x, y, z, yaw); // the hook broadcasts BOAT_SPAWN to everyone, the placer included
    g.audio.playBlock('place', BlockIds.PLANKS, x, y + 0.3, z);
  }

  /** BOAT_ENTER: a seat when one is free, in the order the messages arrived (two at once: the host decides); everyone gets BOAT_RIDERS. */
  _boatEnter(peer, msg) {
    const boats = this.game.entities.boats;
    const boat = boats && boats.byId.get(msg.id);
    if (!boat || !peer.state || peer.dead || peer.mode === 'spectator') return;
    if (Math.hypot(boat.position.x - peer.state[0], boat.position.z - peer.state[2]) > BOAT_REACH + 2) return;
    boats.assign(boat, peer.userId);
  }

  _boatLeave(peer) { const boats = this.game.entities.boats; if (boats) boats.clearRider(peer.userId); }

  /** BOAT_BREAK: an empty boat in reach breaks; the item drops unless the guest plays Creative. */
  _boatBreak(peer, msg) {
    const g = this.game, boats = g.entities.boats;
    const boat = boats && boats.byId.get(msg.id);
    if (!boat || !peer.state || peer.dead || !boat.empty) return;
    if (Math.hypot(boat.position.x - peer.state[0], boat.position.z - peer.state[2]) > BOAT_REACH + 2) return;
    g.breakBoat(boat, peer.mode !== 'creative');
  }

  /** Snap a player back to its last accepted position (its snapshots kept jumping too far). */
  _correct(peer) {
    peer.rejected = 0;
    const s = peer.state;
    console.info(`CraftOn net: correcting ${peer.name || peer.userId} back to ${s[0].toFixed(1)}, ${s[1].toFixed(1)}, ${s[2].toFixed(1)}`);
    peer.link.send(Msg.SPAWN_AT, { x: s[0], y: s[1], z: s[2], reason: 'correction' });
  }

  /** Reset the movement baseline to a position the host ordered (respawn, void, teleport): the next snapshot is accepted from there. */
  _setBaseline(peer, x, y, z) {
    const old = peer.state, now = performance.now() / 1000;
    peer.state = [x, y, z, 0, 0, 0, old ? old[6] : 0, old ? old[7] : 0, ((old ? old[8] : 0) & ~Pose.DEAD) | (peer.dead ? Pose.DEAD : 0)];
    peer.stateTime = now;
    peer.rejected = 0;
    if (peer.remote) { peer.remote.interp.reset(); peer.remote.snapshot(now, peer.state); }
    this._trackChunk(peer); // a teleport: the world loads around the new spot at once
  }

  /** The guest's chunk from its latest position; a crossing (or the first snapshot) re-syncs the chunk manager's extra centers. */
  _trackChunk(peer) {
    const s = peer.state;
    if (!s) return;
    const cx = Math.floor(s[0]) >> 4, cz = Math.floor(s[2]) >> 4;
    if (cx === peer.chunkCX && cz === peer.chunkCZ) return;
    peer.chunkCX = cx; peer.chunkCZ = cz;
    this._syncCenters();
  }

  /** One extra load center per connected guest (ChunkManager.setExtraCenters): the host keeps the world loaded around every player. */
  _syncCenters() {
    const list = [];
    for (const p of this.peers.values()) if (p.state) list.push({ cx: Math.floor(p.state[0]) >> 4, cz: Math.floor(p.state[2]) >> 4 });
    this.game.chunkManager.setExtraCenters(list);
  }

  /** Where a guest respawns: its saved spawn point when it has one, else the world spawn. */
  _spawnFor(peer) {
    const saved = this.game.worldMeta && this.game.worldMeta.guests && this.game.worldMeta.guests[peer.userId];
    const pl = saved && saved.player;
    if (pl && typeof pl.spawnX === 'number') return { x: pl.spawnX, y: pl.spawnY, z: pl.spawnZ };
    const sp = this.game.player.spawn;
    return { x: sp.x, y: sp.y, z: sp.z };
  }

  /** A guest asks to respawn (or fell into the void in Creative): the host places it and resets the baseline. */
  _respawn(peer, msg) {
    if (!peer.ready) return;
    const reason = msg && msg.reason === 'void' ? 'void' : 'respawn';
    const sp = this._spawnFor(peer);
    if (reason === 'respawn') { peer.dead = false; peer.health = 100; peer.respawnedAt = performance.now() / 1000; this._guestRow(peer.userId).health = 100; }
    this._setBaseline(peer, sp.x, sp.y, sp.z);
    peer.link.send(Msg.SPAWN_AT, { x: sp.x, y: sp.y, z: sp.z, reason });
  }

  /** Move a connected player (a future /tp): the baseline follows, so the jump is never rejected. */
  movePeer(userId, x, y, z) {
    const peer = this.peers.get(userId);
    if (!peer) return false;
    this._setBaseline(peer, x, y, z);
    peer.link.send(Msg.SPAWN_AT, { x, y, z, reason: 'teleport' });
    return true;
  }

  _blockRequest(peer, msg) {
    const g = this.game;
    const { x, y, z, id, seq } = msg;
    // `reason` names the real reasons ('far', 'entity'); a stale or malformed request rejects silently.
    const reject = (reason = null) => peer.link.send(Msg.BLOCK_REJECT, { seq, x, y, z, id: g.world.getBlock(x, y, z), reason });
    if (!peer.state || peer.dead || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !Number.isInteger(id)) return reject();
    const dist = Math.hypot(x + 0.5 - peer.state[0], y + 0.5 - (peer.state[1] + 1.6), z + 0.5 - peer.state[2]);
    if (dist > REACH_CREATIVE + 2.5) return reject('far');
    if (!g.world.isLoadedAt(x, z)) return reject('loading'); // the area around the guest is still generating (a teleport, outrunning the host): the guest says so
    const cur = g.world.getBlock(x, y, z);
    const creative = peer.mode === 'creative';
    if (id === 0) {
      if (cur === 0) return reject();
      if (!creative && !isFinite(BREAK_TIME[cur]) && !isLiquid(cur)) return reject(); // bedrock stays in Survival (liquid sources: a bucket)
    } else {
      if (!BlockRegistry.get(id)) return reject();
      if (!BlockRegistry.isReplaceable(cur)) return reject();
      if (!isSupported(g.world, x, y, z, id)) return reject(); // plants need ground, torches a full opaque cube below / behind
      if (BlockRegistry.isTorch(id) && (isLiquid(cur) || y <= 0)) return reject();
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
        breakDependents(g.world, x, y, z, (nx, ny, nz) => g.interaction.breakBlock(nx, ny, nz)); // plants above, torches above and beside
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
      if (!s || other.dead || (s[8] & Pose.SPECTATOR)) continue;
      if (playerBlocksAt(x, y, z, s[0], s[1], s[2], playerHeightForPose(s[8]))) return true;
    }
    return false;
  }

  // ---- Player vs player: the host validates every hit ----

  get pvp() { const m = this.game.worldMeta; return !m || m.pvp !== false; }

  /** The armor value `{ points, cap }` of a connected peer from its replicated armor materials (the shared helper); `{ explosion: true }` for a blast. */
  _peerArmor(peer, opts = undefined) { return armorValueFor(peer.armor || null, opts); }

  /** A guest hit someone (HIT { target, crit, mace, vy }). */
  _hit(peer, msg) {
    if (!peer.state || peer.dead) return;
    this._applyHit({ id: peer.userId, name: peer.name, held: peer.held, mode: peer.mode, x: peer.state[0], y: peer.state[1], z: peer.state[2], peer }, String(msg.target || ''), !!msg.crit, msg.mace ? { mace: true, vy: msg.vy } : msg.spear ? { spear: true, vx: msg.vx, vz: msg.vz } : null);
  }

  /**
   * The host hit a guest (BlockInteraction 'player:hitPlayer'). A mace / spear hit carries the host's own velocity from the click
   * (`extra`, trusted: same process) — for the mace the predicted burst has already set the live velocity to +MACE_BURST_VELOCITY by now.
   */
  hitPlayer(targetId, crit, extra = null) {
    const g = this.game, p = g.player;
    const held = g.inventory.getSelected();
    const num = (v, fallback) => (typeof v === 'number' ? v : fallback);
    const vel = extra && extra.mace ? { mace: true, vy: num(extra.vy, p.velocity.y) } : extra && extra.spear ? { spear: true, vx: num(extra.vx, p.velocity.x), vz: num(extra.vz, p.velocity.z) } : null;
    this._applyHit({ id: this.userId, name: this.name, held: held ? held.itemId : 0, mode: p.gameMode, x: p.position.x, y: p.position.y, z: p.position.z, peer: null }, targetId, crit, vel);
  }

  /**
   * A guest's claimed velocity component (`index` 3 = vx, 4 = vy, 5 = vz of its snapshots) at a mace / spear hit: clamped to
   * ±`bound`, and rejected (null) when it is more than MACE_VY_SLACK off the min / max of that component in its replicated
   * velocities of the last MACE_VY_WINDOW seconds (the latest snapshot when none are that recent). The host's own hits (no peer) use the real value.
   */
  _checkedVel(peer, claimed, index, bound) {
    const v = Math.max(-bound, Math.min(bound, Number(claimed) || 0));
    if (!peer) return v;
    const now = performance.now() / 1000;
    let lo = Infinity, hi = -Infinity;
    for (const h of peer.vyHistory || []) if (now - h[0] <= MACE_VY_WINDOW) { const c = h[index - 2]; if (c < lo) lo = c; if (c > hi) hi = c; }
    if (lo === Infinity) { lo = hi = peer.state ? Number(peer.state[index]) || 0 : 0; }
    if (v < lo - MACE_VY_SLACK || v > hi + MACE_VY_SLACK) { console.info(`CraftOn net: ${peer.name || peer.userId} claimed a ${['vx', 'vy', 'vz'][index - 3]} of ${v.toFixed(1)} blocks/s for a hit (recent ${lo.toFixed(1)} to ${hi.toFixed(1)}): rejected`); return null; }
    return v;
  }
  _checkedVy(peer, claimed) { return this._checkedVel(peer, claimed, 4, TERMINAL_VELOCITY); }

  /** A confirmed smash by a guest: everyone else gets SMASH (the attacker predicted it) and the host plays the effects itself. */
  _confirmSmash(attPeer, x, y, z) {
    this.broadcast(Msg.SMASH, { id: attPeer.userId, x, y, z }, attPeer);
    this.game.smashEffects(x, y, z);
  }

  /** The host's own smash (BlockInteraction predicted it with the real velocities): the guests see it. */
  broadcastSmash(x, y, z) { this.broadcast(Msg.SMASH, { id: this.userId, x, y, z }); }

  /**
   * Reach, cooldown, modes and the PvP toggle, then the damage goes to the victim and everyone sees the hit. A mace hit
   * (`mace: { vy }`, only when the attacker really holds one) takes its damage from the closing speed between the attacker's
   * checked velocity.y and the victim's latest one (no 1.5× crit; a smash shows the crit stars and is announced with SMASH).
   */
  _applyHit(att, targetId, crit, vel = null) {
    const g = this.game;
    if (!this.pvp || att.mode === 'spectator') return;
    const now = performance.now() / 1000;
    const attPeer = att.peer || this;
    if (now - (attPeer.lastHit || 0) < 0.45) return;
    let vx, vy, vz, vMode, vPoints, victimPeer = null, victimVy, victimVx, victimVz;
    if (targetId === this.userId) { const p = g.player; if (p.dead) return; vx = p.position.x; vy = p.position.y; vz = p.position.z; vMode = p.gameMode; vPoints = g.inventory.armorValue(); victimVy = p.velocity.y; victimVx = p.velocity.x; victimVz = p.velocity.z; }
    else { victimPeer = this.peers.get(targetId); if (!victimPeer || !victimPeer.state || victimPeer.dead) return; vx = victimPeer.state[0]; vy = victimPeer.state[1]; vz = victimPeer.state[2]; vMode = victimPeer.mode; vPoints = this._peerArmor(victimPeer); victimVx = Number(victimPeer.state[3]) || 0; victimVy = Number(victimPeer.state[4]) || 0; victimVz = Number(victimPeer.state[5]) || 0; }
    if (vMode !== 'survival') return;
    const victim = victimPeer || this;
    if (now - (victim.lastHurt || 0) < 0.45) return;
    const dist = Math.hypot(vx - att.x, vy + 0.9 - (att.y + 1.6), vz - att.z);
    if (dist > PVP_REACH + PVP_REACH_SLACK) return;
    let n, smash = false;
    if (vel && vel.mace && isMace(att.held)) {
      // The mace: the damage comes from the closing speed between the attacker's (checked) velocity.y and the victim's latest one; no 1.5× crit.
      const attVy = this._checkedVy(att.peer, vel.vy);
      if (attVy === null) return;
      const closing = maceClosingSpeed(attVy, victimVy);
      n = macePlayerDamage(closing, vPoints);
      smash = isMaceSmash(closing);
      crit = smash; // a smash shows the crit stars
    } else if (vel && vel.spear && isSpear(att.held)) {
      // A spear: the horizontal closing speed between the attacker's (checked) vx / vz and the victim's latest ones, along the line between them; no 1.5× crit.
      const attVx = this._checkedVel(att.peer, vel.vx, 3, SPEAR_VELOCITY_CLAMP), attVz = this._checkedVel(att.peer, vel.vz, 5, SPEAR_VELOCITY_CLAMP);
      if (attVx === null || attVz === null) return;
      const d = horizontalDir(att.x, att.z, vx, vz);
      const closing = spearClosingSpeed(attVx, attVz, victimVx, victimVz, d.dx, d.dz);
      n = spearPlayerDamage(attackDamage(att.held), closing, vPoints);
      crit = isSpearFast(closing); // a fast hit shows the crit stars
    } else n = pvpDamage(attackDamage(att.held), crit, vPoints);
    attPeer.lastHit = now; victim.lastHurt = now;
    const dx = vx - att.x, dz = vz - att.z, len = Math.hypot(dx, dz) || 1;
    const kx = dx / len, kz = dz / len;
    if (victimPeer) {
      victimPeer.link.send(Msg.DAMAGE, { n, by: att.name, kx, kz, crit });
      if (victimPeer.remote) victimPeer.remote.hurt(crit, n);
    } else g.health.damage(n, { kind: 'pvp', by: att.name }, { kx, kz, crit, ignoreInvuln: true });
    this.broadcast(Msg.HURT, { id: targetId, crit, n }, victimPeer);
    if (smash && att.peer) this._confirmSmash(att.peer, vx, vy, vz);
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
    peer.dead = true;
    peer.health = 0;
    this._guestRow(peer.userId).health = 0;
    const text = deathMessage(peer.name, msg.cause);
    this.game.systemChat(text, 'yellow', false);
    this.broadcast(Msg.DEATH, { id: peer.userId, text }, peer);
  }

  /** The host died: tell the guests (the host's own chat already shows its death screen message). */
  announceOwnDeath(cause) { const text = deathMessage(this.name, cause); this.game.ui.chat.system(text, 'yellow'); this.broadcast(Msg.DEATH, { id: this.userId, text }); }

  // ---- Chat ----

  /** A guest's chat line: validated (length, control characters, about 5 per 5 s) and sent to everyone with the name the guest joined with — never a name from the message. */
  _chat(peer, msg) {
    if (!peer.ready) return;
    const text = cleanChatText(msg && msg.text);
    if (!text) return;
    const now = performance.now();
    peer.chatTimes = (peer.chatTimes || []).filter((t) => now - t < CHAT_WINDOW_MS);
    if (peer.chatTimes.length >= CHAT_LIMIT) { peer.link.send(Msg.CHAT, { system: 'Slow down: at most 5 messages every 5 seconds.', color: 'red' }); return; }
    peer.chatTimes.push(now);
    this.game.ui.chat.add({ name: peer.name, text, host: false });
    this.broadcast(Msg.CHAT, { name: peer.name, text, host: false });
  }

  /** The host's own line (already shown locally). */
  broadcastChat(name, text, host = true) { this.broadcast(Msg.CHAT, { name, text, host }); }

  /** A system line for every guest (joins, leaves, deaths). */
  broadcastSystem(text, color = 'yellow') { this.broadcast(Msg.CHAT, { system: text, color }); }

  /** /tick: guests follow the host's rate and freeze state. */
  broadcastTick(tick) { this.broadcast(Msg.TICK, { rate: tick.rate, frozen: !!tick.frozen }); }

  /** PvP / keep inventory / hostile mobs / explosives / fall damage / natural spawning changed in Server Settings: guests follow. */
  broadcastWorldSettings() { this.broadcast(Msg.WORLD, worldSettingsMessage(this.game.worldMeta)); }

  /** A zombie hit a guest (MobManager.hurtPlayer): the base damage reduced by the guest's replicated armor, knockback away from the zombie, everyone sees the flash. */
  zombieHit(userId, base, kx, kz) {
    const peer = this.peers.get(userId);
    if (!peer || !peer.state || peer.dead || peer.mode !== 'survival') return;
    const now = performance.now() / 1000;
    if (now - (peer.lastHurt || 0) < 0.45) return;
    peer.lastHurt = now;
    const n = zombieDamage(this._peerArmor(peer), base);
    peer.link.send(Msg.DAMAGE, { n, kind: 'zombie', kx, kz });
    if (peer.remote) peer.remote.hurt(false, n);
    this.broadcast(Msg.HURT, { id: userId, crit: false, n }, peer);
  }

  /**
   * A guest hit a mob (ATTACK { id, damage, crit, kb, mace, vy } or { …, spear, vx, vz }): the damage is applied as sent (no limit
   * for any item; only a non-number is guarded and falls back to the empty hand's HAND_ATTACK_DAMAGE; a spear's fast-hit flag
   * travels as `crit`), and a mace hit's smash is confirmed from
   * the checked velocities (the mob's real velocity.y is here).
   */
  _attack(peer, msg) {
    const mobs = this.game.entities.mobs;
    const mob = mobs.byId.get(msg.id);
    if (!mob || !peer.state || peer.dead) return;
    const d = Math.hypot(mob.position.x - peer.state[0], mob.position.z - peer.state[2]);
    if (d > 6) return;
    const damage = Math.max(0, Number(msg.damage) || HAND_ATTACK_DAMAGE);
    const kb = Math.max(0.5, Math.min(3, Number(msg.kb) || 1)); // a stick: ×2
    let smash = false;
    if (msg.mace && isMace(peer.held)) { const vy = this._checkedVy(peer, msg.vy); smash = vy !== null && isMaceSmash(maceClosingSpeed(vy, mob.velocity.y)); }
    mobs.hit(mob, damage, peer.state[0], peer.state[2], !!msg.crit || smash, true, kb);
    if (smash) this._confirmSmash(peer, mob.position.x, mob.position.y, mob.position.z);
  }

  /**
   * A guest shot an arrow (SHOOT { ox, oy, oz, dx, dy, dz, power }): the origin must be near the guest's eyes, the power
   * 0.05..1, at most one shot every 0.15 s, and a Survival guest needs an arrow (its replicated inventory count); then the
   * host simulates the arrow and everyone gets ARROW_SPAWN.
   */
  _shoot(peer, msg) {
    if (!peer.state || peer.dead || peer.mode === 'spectator') return;
    const now = performance.now() / 1000;
    if (now - (peer.lastShot || 0) < 0.15) return;
    const ox = Number(msg.ox), oy = Number(msg.oy), oz = Number(msg.oz);
    let dx = Number(msg.dx), dy = Number(msg.dy), dz = Number(msg.dz);
    const power = Math.max(0.05, Math.min(1, Number(msg.power) || 0));
    if (![ox, oy, oz, dx, dy, dz].every(Number.isFinite)) return;
    if (Math.hypot(ox - peer.state[0], oy - (peer.state[1] + 1.6), oz - peer.state[2]) > 2.5) return; // not from the eyes
    const len = Math.hypot(dx, dy, dz); if (len < 1e-3) return; dx /= len; dy /= len; dz /= len;
    const survival = peer.mode === 'survival';
    if (survival && !this._peerHasArrow(peer)) return;
    peer.lastShot = now;
    this.game.entities.shootArrow({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, power, peer.userId, { pickup: survival });
  }

  /** The chest a guest may use: integer coordinates, a loaded chest block within reach of the guest. */
  _chestFor(peer, msg) {
    const g = this.game;
    const { x, y, z } = msg;
    if (!peer.state || peer.dead || peer.mode === 'spectator' || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null;
    if (!g.world.isLoadedAt(x, z) || !BlockRegistry.isContainer(g.world.getBlock(x, y, z))) return null;
    if (Math.hypot(x + 0.5 - peer.state[0], y + 0.5 - (peer.state[1] + 1.6), z + 0.5 - peer.state[2]) > REACH_CREATIVE + 3) return null;
    return g.chests.open(x, y, z);
  }

  /** A guest opened a chest: it gets the real contents (its own copy may be stale). */
  _chestOpen(peer, msg) {
    const st = this._chestFor(peer, msg);
    if (!st) return;
    peer.link.send(Msg.CHEST_CONTENTS, { x: msg.x, y: msg.y, z: msg.z, slots: st.serialize() });
  }

  /**
   * A guest's chest operation, applied to the real contents and answered with CHEST_ACK: 'exchange' (a click with the
   * guest's cursor: the new cursor comes back), 'takeAll' (the slot's stack comes back for the guest's inventory), 'put'
   * (items into a slot, or anywhere with slot −1: the accepted count comes back). The changed slots reach everyone.
   */
  _chestOp(peer, msg) {
    const seq = msg.seq;
    const reply = (r) => peer.link.send(Msg.CHEST_ACK, { seq, ...r });
    const st = this._chestFor(peer, msg);
    if (!st) return reply({ ok: false });
    const slot = msg.slot | 0;
    if (msg.op === 'exchange') {
      if (slot < 0 || slot >= st.size) return reply({ ok: false });
      const cursor = msg.cursor ? ItemStack.deserialize(msg.cursor) : null;
      const r = clickSlot(st.get(slot), cursor, msg.button === 2 ? 2 : 0);
      st.set(slot, r.slot);
      return reply({ ok: true, cursor: r.cursor ? r.cursor.serialize() : null });
    }
    if (msg.op === 'takeAll') {
      if (slot < 0 || slot >= st.size) return reply({ ok: false });
      const s = st.get(slot);
      st.set(slot, null);
      return reply({ ok: true, stack: s ? s.serialize() : null });
    }
    if (msg.op === 'put') {
      const id = msg.id | 0, n = Math.max(0, Math.min(64, msg.n | 0));
      if (!ItemRegistry.has(id) || n <= 0) return reply({ ok: false });
      if (slot === -1) { const left = st.addItem(id, n); return reply({ ok: true, n: n - left }); }
      if (slot < 0 || slot >= st.size) return reply({ ok: false });
      const r = putIntoSlot(st.get(slot), id, n);
      if (r.accepted > 0) st.set(slot, r.slot);
      return reply({ ok: true, n: r.accepted });
    }
    return reply({ ok: false });
  }

  /** A guest used a spawn egg (Creative only): the mob is spawned at the clicked cell past the caps and broadcast like every host spawn. */
  _spawnEgg(peer, msg) {
    const g = this.game;
    const def = MOB_BY_TYPE[msg.type];
    const x = msg.x | 0, y = msg.y | 0, z = msg.z | 0;
    if (!def || !peer.state || peer.dead || peer.mode !== 'creative') return;
    if (Math.hypot(x + 0.5 - peer.state[0], y + 0.5 - (peer.state[1] + 1.6), z + 0.5 - peer.state[2]) > REACH_CREATIVE + 3) return;
    if (!g.world.isLoadedAt(x, z)) { peer.link.send(Msg.CHAT, { system: 'That spot is not loaded on the server yet.', color: 'gray' }); return; }
    if (def.hostile && !g.entities.mobs.hostileEnabled) { peer.link.send(Msg.CHAT, { system: 'Hostile mobs are turned off in this world.', color: 'gray' }); return; }
    g.entities.mobs._add(def, x + 0.5, y, z + 0.5, (Math.random() * 4294967296) >>> 0, Math.random() * Math.PI * 2, def.health, null, true);
  }

  /** A guest fired a rocket while gliding: it needs a rocket in its replicated inventory (none in Creative) and 0.2 s since the last; everyone hears the launch. */
  _rocket(peer) {
    if (!peer.state || peer.dead || peer.mode === 'spectator') return;
    const now = performance.now() / 1000;
    if (now - (peer.lastRocket || 0) < 0.2) return;
    if (peer.mode !== 'creative' && !this._peerHasItem(peer, ItemIds.ROCKET)) return;
    peer.lastRocket = now;
    peer.link.send(Msg.ROCKET_OK, {});
    this.game.audio.playAt('items/rocket_launch', peer.state[0], peer.state[1] + 1, peer.state[2], 'blocks', 0.9); // the host hears it too
    this.broadcast(Msg.SOUND, { id: peer.userId, name: 'items/rocket_launch', x: peer.state[0], y: peer.state[1] + 1, z: peer.state[2], vol: 0.9 }, peer);
  }

  /**
   * A guest used a rocket as a dash (ROCKET_DASH, already applied on its side): a Survival guest needs a rocket in its replicated
   * inventory and the dash cooldown must have passed; then the launch sound plays here and goes to the other guests. A rejected
   * dash is only logged — it cannot be undone smoothly (the guest already moved).
   */
  _rocketDash(peer) {
    if (!peer.state || peer.dead || peer.mode === 'spectator') return;
    const now = performance.now() / 1000;
    const reason = now - (peer.lastDash || 0) < ROCKET_DASH_COOLDOWN ? 'cooldown' : peer.mode !== 'creative' && !this._peerHasItem(peer, ItemIds.ROCKET) ? 'no rocket' : null;
    if (reason) { console.info(`CraftOn net: ${peer.name || peer.userId} dashed with a rocket (${reason}): ignored`); return; }
    peer.lastDash = now;
    this.game.audio.playAt('items/rocket_launch', peer.state[0], peer.state[1] + 1, peer.state[2], 'blocks', 0.9);
    this.broadcast(Msg.SOUND, { id: peer.userId, name: 'items/rocket_launch', x: peer.state[0], y: peer.state[1] + 1, z: peer.state[2], vol: 0.9 }, peer);
  }

  /** The guest's replicated inventory (its last INV / META sync) holds at least one of `itemId`; unknown inventories pass. */
  _peerHasItem(peer, itemId) {
    const row = this._guestRow(peer.userId);
    const inv = row && row.inventory;
    if (!inv || !Array.isArray(inv.slots)) return true;
    return inv.slots.some((s) => s && s.id === itemId && s.n > 0);
  }

  /** The guest's replicated inventory (its last INV / META sync) holds at least one arrow; unknown inventories pass. */
  _peerHasArrow(peer) {
    const row = this._guestRow(peer.userId);
    const inv = row && row.inventory;
    if (!inv || !Array.isArray(inv.slots)) return true;
    return inv.slots.some((s) => s && s.id === ItemIds.ARROW && s.n > 0);
  }

  /** A guest placed an explosive (PRIME { x, y, z }): within reach of its position, the cell free, explosives allowed → primed and announced. */
  _prime(peer, msg) {
    const m = this.game.worldMeta;
    if (m && m.explosives === false) { peer.link.send(Msg.CHAT, { system: 'Explosives are turned off in this world.', color: 'gray' }); return; }
    if (!peer.state || peer.dead || peer.mode === 'spectator') return;
    const x = msg.x | 0, y = msg.y | 0, z = msg.z | 0;
    if (Math.hypot(x + 0.5 - peer.state[0], y - peer.state[1], z + 0.5 - peer.state[2]) > 8) return;
    const w = this.game.world;
    if (!w.isLoadedAt(x, z) || !BlockRegistry.isReplaceable(w.getBlock(x, y, z))) return;
    this.game.entities.primeExplosive(x, y, z);
  }

  /** A guest's stuck Survival arrow: granted back when the guest stands at it. */
  _arrowPickup(a) {
    const peer = this.peers.get(a.shooter);
    if (!peer || !peer.state || peer.dead || peer.mode !== 'survival') return;
    const e = 0.6 + PLAYER_WIDTH / 2, q = a.position, px = peer.state[0], py = peer.state[1], pz = peer.state[2];
    if (q.x < px - e || q.x > px + e || q.y < py - 0.6 || q.y > py + PLAYER_HEIGHT + 0.6 || q.z < pz - e || q.z > pz + e) return;
    this.game.entities.removeArrow(a);
    peer.link.send(Msg.ITEM_GRANT, { item: ItemIds.ARROW, n: 1 });
  }

  /**
   * An arrow or an explosion of the host's simulation reached a guest (EntityManager.hurtPlayer): PvP applies to arrows,
   * the damage uses the guest's replicated armor, the guest gets DAMAGE (with the knockback) and everyone the flash.
   */
  projectileHit(shooter, hit) {
    const peer = this.peers.get(hit.id);
    if (!peer || !peer.state || peer.dead || peer.mode !== 'survival') return;
    let n, cause;
    if (hit.kind === 'arrow') {
      if (!this.pvp) return;
      const by = shooter === 'self' ? this.name : (this.peers.get(shooter) || {}).name || 'another player';
      n = arrowPlayerDamage(hit.power, hit.bonus, this._peerArmor(peer)); cause = { kind: 'arrow', by };
    } else { n = explosionPlayerDamage(hit.impact, hit.power, this._peerArmor(peer, { explosion: true })); cause = { kind: 'explosion' }; } // the guest's explosion value: obsidian / Encorsed ×1.5 and the explosion cap
    if (n <= 0) return;
    peer.lastHurt = performance.now() / 1000;
    const k = hit.kind === 'explosion' ? EXPLOSION_KNOCKBACK * hit.impact / 6 : 1; // DAMAGE knockback is kx × 6
    peer.link.send(Msg.DAMAGE, { n, kind: cause.kind, by: cause.by, kx: hit.kx * k, kz: hit.kz * k, ky: hit.kind === 'explosion' ? hit.ky * EXPLOSION_KNOCKBACK * hit.impact : 0, crit: !!hit.crit });
    if (peer.remote) peer.remote.hurt(!!hit.crit, n);
    this.broadcast(Msg.HURT, { id: peer.userId, crit: !!hit.crit, n }, peer);
  }

  _pickup(peer, msg) {
    const items = this.game.entities;
    const it = items.byId.get(msg.id);
    if (!it || it.dead || !peer.state || peer.dead) return;
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
      // The host validates mode changes: without permission (or in a locked world) the guest is told its real mode again.
      if (!peer.canChangeMode || !MODES.includes(msg.mode) || this.game.lockedMode) { peer.link.send(Msg.MODE, { mode: peer.mode, canChange: !!peer.canChangeMode }); delete msg.mode; }
      else { peer.mode = msg.mode; this._guestRow(peer.userId).mode = msg.mode; this.game.session.changedSinceSave = true; }
    }
    if (peer.remote) peer.remote.setMeta(msg);
    this.broadcast(Msg.META, { ...msg, id: peer.userId }, peer);
  }

  _storeGuest(peer, msg) {
    const meta = this.game.worldMeta;
    if (!meta) return;
    // The spawn is the host's to decide (_spawnFor): a guest's self-reported spawn never replaces the one the host recorded.
    const prev = meta.guests[peer.userId], player = msg.player && typeof msg.player === 'object' ? { ...msg.player } : null;
    if (player) {
      delete player.spawnX; delete player.spawnY; delete player.spawnZ;
      if (prev && prev.player && typeof prev.player.spawnX === 'number') { player.spawnX = prev.player.spawnX; player.spawnY = prev.player.spawnY; player.spawnZ = prev.player.spawnZ; }
    }
    meta.guests[peer.userId] = { name: peer.name, player, inventory: msg.inventory || null, lastSeen: Date.now(), mode: peer.mode || this.defaultMode, canChangeMode: !!peer.canChangeMode };
    this.game.session.changedSinceSave = true;
  }

  // ---- Game mode permissions: the host decides every guest's mode -------------------------

  /** Mode new guests start in: the locked mode of a locked world, else meta.defaultGameMode (Server Settings), else the world's own mode. */
  get defaultMode() { const meta = this.game.worldMeta; return this.game.lockedMode || (meta && MODES.includes(meta.defaultGameMode) && meta.defaultGameMode) || (meta && meta.gameMode) || 'survival'; }

  setDefaultMode(mode) {
    const meta = this.game.worldMeta;
    if (!meta || !MODES.includes(mode) || this.game.lockedMode) return;
    meta.defaultGameMode = mode;
    this.game.session.changedSinceSave = true;
  }

  /** /give for a guest: the existing ITEM_GRANT (its inventory adds it; what does not fit is thrown back for the host to spawn). */
  grantItem(userId, itemId, n) {
    const peer = this.peers.get(userId);
    if (!peer || !peer.ready) return false;
    peer.link.send(Msg.ITEM_GRANT, { item: itemId, n });
    return true;
  }

  /**
   * A guest's cheat command (Msg.COMMAND { name, argv }): only commands the host runs for guests (/tp, /give, /summon,
   * /spawn), never in a world locked to Survival, only with the cheats permission; parsed like the host's own and run with
   * the guest as the actor (its replicated position). Every reply goes to that guest alone, as a system chat line.
   */
  _command(peer, msg) {
    if (!peer.ready || !peer.state) return;
    const g = this.game, reg = g.commands;
    const reply = (text, kind) => peer.link.send(Msg.CHAT, { system: Array.isArray(text) ? text.map((p) => p.text).join('') : String(text), color: kind === 'error' ? 'red' : 'gray' });
    const cmd = reg.get(String(msg && msg.name || '').toLowerCase());
    if (!cmd || !cmd.remote) { reply('Unknown command. Type /help', 'error'); return; }
    if (g.lockedMode === 'survival') { reply(lockedText('survival'), 'error'); return; }
    if (!peer.canChangeMode) { reply(NO_CHEATS_TEXT, 'error'); return; }
    const argv = Array.isArray(msg.argv) ? msg.argv.slice(0, 8).map((a) => String(a).slice(0, 64)) : [];
    const m = reg.match(cmd, argv);
    if (m.error) { reply(m.error, 'error'); return; }
    const actor = { id: peer.userId, name: peer.name, x: peer.state[0], y: peer.state[1], z: peer.state[2], remote: true };
    try { cmd.run(g, argv, reply, m, actor); }
    catch (e) { console.warn(`CraftOn command /${cmd.name} (for ${peer.name}) failed`, e); reply(`/${cmd.name} failed: ${e.message || e}`, 'error'); }
  }

  /** The saved row of a guest (created with the default mode and no permission). */
  _guestRow(userId) {
    const meta = this.game.worldMeta;
    if (!meta.guests[userId]) meta.guests[userId] = { name: '', player: null, inventory: null, lastSeen: Date.now(), mode: this.defaultMode, canChangeMode: false };
    return meta.guests[userId];
  }

  /**
   * Everyone the server knows for the Server Settings screen: connected players first (with their ping and connection
   * type), then saved guests, then banned accounts that never played here. `banned` marks accounts in meta.bans.
   */
  guestRows() {
    const meta = this.game.worldMeta;
    const bans = this.bans;
    const rows = [], seen = new Set();
    for (const p of this.peers.values()) { seen.add(p.userId); rows.push({ userId: p.userId, name: p.name, mode: p.mode, canChangeMode: !!p.canChangeMode, online: true, ping: Math.round(p.link.rtt), connection: p.link.connectionType, banned: !!bans[p.userId] }); }
    for (const [id, gst] of Object.entries(meta ? meta.guests : {})) {
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ userId: id, name: gst.name || id.slice(0, 8), mode: MODES.includes(gst.mode) ? gst.mode : this.defaultMode, canChangeMode: !!gst.canChangeMode, online: false, ping: null, connection: null, banned: !!bans[id] });
    }
    for (const [id, b] of Object.entries(bans)) {
      if (seen.has(id)) continue;
      rows.push({ userId: id, name: (b && b.name) || id.slice(0, 8), mode: this.defaultMode, canChangeMode: false, online: false, ping: null, connection: null, banned: true });
    }
    return rows;
  }

  // ---- Kick and Ban ----

  /** userId → { name, at } in the world save (created on first use). */
  get bans() { const meta = this.game.worldMeta; if (!meta) return {}; if (!meta.bans || typeof meta.bans !== 'object') meta.bans = {}; return meta.bans; }
  isBanned(userId) { return !!(userId && Object.prototype.hasOwnProperty.call(this.bans, userId)); }

  /** Disconnect a connected player with a reason it will see; returns false when nobody by that id is connected. */
  kick(userId, reason = RejectReason.KICKED) {
    const peer = this.peers.get(userId);
    if (!peer) return false;
    peer.kicked = reason;
    peer.link.send(Msg.KICK, { reason });
    setTimeout(() => this._peerClosed(peer, reason === RejectReason.BANNED ? 'banned' : 'kicked'), 300); // the message gets out first
    return true;
  }

  /** Ban an account for this world (saved with it) and kick it if it is connected. */
  ban(userId, name = null) {
    if (!userId || userId === this.userId) return false;
    const peer = this.peers.get(userId);
    const meta = this.game.worldMeta;
    const known = (meta && meta.guests && meta.guests[userId] && meta.guests[userId].name) || null;
    this.bans[userId] = { name: String(name || (peer && peer.name) || known || userId.slice(0, 8)).slice(0, 16), at: Date.now() };
    this.game.session.changedSinceSave = true;
    if (peer) this.kick(userId, RejectReason.BANNED);
    this.game.events.emit('net:changed');
    return true;
  }

  unban(userId) {
    if (!this.isBanned(userId)) return false;
    delete this.bans[userId];
    this.game.session.changedSinceSave = true;
    this.game.events.emit('net:changed');
    return true;
  }

  /** Host sets a guest's mode (saved; a connected guest switches at once and everyone sees the new mode). Never in a locked world. */
  setGuestMode(userId, mode) {
    if (!MODES.includes(mode) || this.game.lockedMode) return false;
    this._guestRow(userId).mode = mode;
    this.game.session.changedSinceSave = true;
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.mode = mode;
    if (peer.remote) peer.remote.setMeta({ mode });
    peer.link.send(Msg.MODE, { mode, canChange: !!peer.canChangeMode });
    this.broadcast(Msg.META, { mode, id: peer.userId }, peer);
    return true;
  }

  /** Host toggles "Can use cheats (game mode and commands)" for a guest (saved; a connected guest learns about it at once). Never granted in a world locked to Survival. */
  setGuestCanChange(userId, allowed) {
    if (allowed && this.game.lockedMode === 'survival') return false;
    this._guestRow(userId).canChangeMode = !!allowed;
    this.game.session.changedSinceSave = true;
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.canChangeMode = !!allowed;
    peer.link.send(Msg.MODE, { mode: peer.mode, canChange: peer.canChangeMode });
    return true;
  }

  _peerClosed(peer, reason) {
    if (this.peers.has(peer.userId)) console.info(`CraftOn net: ${peer.name || peer.userId} left (${reason})`);
    const wasIn = this.peers.delete(peer.userId);
    this.pending.delete(peer.userId);
    try { peer.link.close(); } catch (e) { /* ignore */ }
    if (!wasIn) return;
    if (peer.remote) { this.remote.remove(peer.userId); peer.remote = null; }
    if (this.game.entities.boats) this.game.entities.boats.clearRider(peer.userId); // out of its boat: the boat stays and the host simulates it again
    this._syncCenters(); // its far chunks are let go
    this.broadcast(Msg.LEAVE, { id: peer.userId });
    if (this.running) this.game.systemChat(`${peer.name || 'A player'} ${peer.kicked === RejectReason.BANNED ? 'was banned from the server' : peer.kicked ? 'was kicked from the server' : 'left the game'}`, 'yellow');
    this._heartbeat();
    if (this.running) this.game._netChanged(); // the last guest gone: a lan-mode world pauses like single player again
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
      // Boats: a guest-driven one is relayed as its driver last sent it; the host's own (driven by the host, or empty) only while it moves, plus one row as it stops.
      let boatRows = null;
      const boats = this.game.entities.boats;
      if (boats) for (const b of boats.list) {
        let row = null;
        if (b.driver !== null && b.driver !== this.userId) row = b.lastState;
        else { const moving = b.speed > 0.01 || Math.abs(b.velocity.y) > 0.01; if (b.driver === this.userId || moving || b.sentMoving) row = b.stateRow(); b.sentMoving = moving; }
        if (row) (boatRows || (boatRows = [])).push(row);
      }
      this.broadcast(Msg.PS, boatRows ? { list, boats: boatRows } : { list }, null, 'state');
    }
    this.mobTimer += dt;
    if (this.mobTimer >= 1 / MOB_SNAPSHOT_HZ) {
      this.mobTimer = 0;
      const mobs = this.game.entities.mobs.mobs.filter((m) => !m.frozen).map((m) => [m.id, +m.position.x.toFixed(3), +m.position.y.toFixed(3), +m.position.z.toFixed(3), +m.yaw.toFixed(3), +m.headYaw.toFixed(3), +m.velocity.x.toFixed(2), +m.velocity.z.toFixed(2)]);
      const items = this.game.entities.items.map((it) => [it.id, +it.position.x.toFixed(3), +it.position.y.toFixed(3), +it.position.z.toFixed(3)]);
      const ex = this.game.entities.explosives.map((e) => [e.id, +e.position.x.toFixed(3), +e.position.y.toFixed(3), +e.position.z.toFixed(3)]);
      this.broadcast(Msg.M, { mobs, items, ex: ex.length ? ex : undefined }, null, 'state');
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
    this.game.chunkManager.setExtraCenters([]); // back to the host's own area only
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
