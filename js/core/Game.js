// Game.js — owns every subsystem, wires them together, and runs the per-frame / fixed-step logic.

import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Settings } from './Settings.js';
import { GameState, State } from './GameState.js';
import { GameLoop } from './GameLoop.js';
import { WorldSession } from './WorldSession.js';
import { InputManager } from '../input/InputManager.js';
import { ActionMap } from '../input/ActionMap.js';
import { KeyBindingStore } from './KeyBindingStore.js';
import { PAUSE_CODE } from '../config/KeyBindings.js';
import { Renderer } from '../rendering/Renderer.js';
import { TextureAtlas } from '../rendering/TextureAtlas.js';
import { ChunkMeshManager } from '../rendering/ChunkMeshManager.js';
import { Sky } from '../rendering/Sky.js';
import { SelectionBox } from '../rendering/SelectionBox.js';
import { BreakOverlay } from '../rendering/BreakOverlay.js';
import { ParticleSystem } from '../rendering/Particles.js';
import { BlockIconRenderer } from '../rendering/BlockIconRenderer.js';
import { createBlockModelMaterial } from '../rendering/Materials.js';
import { World } from '../world/World.js';
import { ChunkManager } from '../world/ChunkManager.js';
import { Inventory } from '../items/Inventory.js';
import { Player, GameMode, GAME_MODE_ORDER } from '../player/Player.js';
import { CloudSaveManager } from './CloudSaveManager.js';
import { Account } from './Account.js';
import { createCloudClient } from './cloud/CloudClient.js';
import { MobManager } from '../entities/mobs/MobManager.js';
import { loadEntityTextures } from '../entities/mobs/MobModel.js';
import { StartupTiming } from './StartupTiming.js';
import { BootScreen } from '../ui/BootScreen.js';
import { TEXTURE_NAMES } from '../rendering/AtlasLayout.js';
import { SessionGuard } from './SessionGuard.js';
import { HostServer } from '../net/HostServer.js';
import { GuestClient } from '../net/GuestClient.js';
import { RemotePlayerManager } from '../net/RemotePlayer.js';
import { remotePlayersBlockAt, mobBlocksAt } from '../player/PlacementRules.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import { HealthSystem } from '../player/HealthSystem.js';
import { ShaderPipeline } from '../rendering/shaders/ShaderPipeline.js';
import { applyBrightness, lightFactor } from '../rendering/LightUniforms.js';
import { getTileIndex } from '../rendering/AtlasLayout.js';
import { CHUNK_SIZE } from '../config/Constants.js';
import { MAX_PLAYERS_DEFAULT } from '../net/Protocol.js';
import { chunkKeyString } from '../world/ChunkCoords.js';
import { intersectsSolid } from '../entities/EntityPhysics.js';
import { SPECTATOR_SPEED_MIN, SPECTATOR_SPEED_MAX, SPECTATOR_SPEED_STEP } from '../config/Constants.js';
import { PlayerController } from '../player/PlayerController.js';
import { PlayerPhysics } from '../player/PlayerPhysics.js';
import { CameraController, Perspective } from '../player/CameraController.js';
import { BlockRaycaster } from '../player/BlockRaycaster.js';
import { BlockInteraction } from '../player/BlockInteraction.js';
import { PlayerModel } from '../player/models/PlayerModel.js';
import { FirstPersonHand } from '../player/models/FirstPersonHand.js';
import { createModelLights } from '../player/models/ModelParts.js';
import { EntityManager } from '../entities/EntityManager.js';
import { AudioManager } from '../audio/AudioManager.js';
import { UIManager } from '../ui/UIManager.js';
import { GuiScale } from '../ui/GuiScale.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { SWIM_STROKE_INTERVAL, WATER_TICK_SECONDS, ITEM_PICKUP_DELAY } from '../config/Constants.js';
import { WaterSimulation } from '../world/WaterSimulation.js';
import { CraftingSystem } from '../crafting/CraftingSystem.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { ItemRegistry } from '../items/ItemRegistry.js';

const STEP_DISTANCE = 1.6;

export class Game {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** Startup phase timings (boot and Play), printed with ?debuglog. Created first so it starts with the module code. */
    this.timing = new StartupTiming();
    this.bootScreen = new BootScreen();
    this.debuglog = false;
    this.events = new EventBus();
    this.settings = new Settings(this.events);
    this.state = new GameState(this.events);
    this.input = new InputManager(canvas, this.events);
    this.keybinds = new KeyBindingStore(this.events);
    this.actions = new ActionMap(this.input, this.keybinds);
    this.input.shouldPreventDefault = (code) => this.keybinds.shouldPreventDefault(code);
    this.renderer = new Renderer(canvas, this.settings, this.events);
    this.guiScale = new GuiScale(this.settings, this.events);
    this.atlas = new TextureAtlas();
    this.audio = new AudioManager(this.settings, this.events);
    this.world = new World(this.events);
    /** Cloud client (supabase-js or the mock with ?mockcloud), account and save manager are created in boot(). */
    this.cloudMock = false;
    this.cloud = null;
    this.account = null;
    this.saveManager = null;
    /** Resolves to true when a persisted session was restored (started inside boot(), awaited by main.js). */
    this.sessionTask = null;
    /** One place per account (Update #8): claims, heartbeat, kick. Created with the account in boot(). */
    this.sessionGuard = null;
    this.kicked = false;
    /** LAN multiplayer (Update #8): a HostServer while hosting, a GuestClient while joined, else null. */
    this.net = null;
    this.remotePlayers = null;
    this.networkInfo = null;
    /** Prefetched world list (Game.prefetchWorlds) consumed by the world menu. */
    this.worldsPromise = null;
    this.inventory = new Inventory(this.events);
    this.player = new Player();
    this.session = new WorldSession(this);
    this.ui = new UIManager(this);
    this.loop = new GameLoop((dt) => this.fixedUpdate(dt), (alpha, dt) => this.frame(alpha, dt));
    this.worldMeta = null;
    this.expectUnlock = false;
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._lastStepDistance = 0;
    this._swimTimer = 0;
    this._waterTimer = 0;
    this._hiddenSince = 0;
    /** Optional hook invoked right after each world render (used by the debug/test harness). */
    this.afterRender = null;
    /** Debug harness: keep simulating while the tab reports itself hidden. */
    this.ignoreHidden = false;
  }

  /**
   * Load textures, build every subsystem and start the loop. Independent work runs in parallel (Update #7):
   * the cloud client + session check (+ world list prefetch), the block atlas, the mob / armor sheets and the
   * background sound pre-render. `onStep(text, fraction)` feeds the boot screen. Resolves once the account and
   * save manager exist; the session result is `this.sessionTask`.
   */
  async boot(onStep = () => {}) {
    const T = this.timing;
    onStep('Loading textures…', 0.05);
    const cloudPhase = T.start('cloud client');
    const cloudTask = createCloudClient({ mock: this.cloudMock }).then((client) => {
      this.cloud = client;
      this.account = new Account(client, this.events);
      this.saveManager = new CloudSaveManager(client);
      this.sessionGuard = new SessionGuard(client, this.account, (reason) => this.onKicked(reason));
      this.sessionGuard.log = (m) => { if (this.debuglog) console.log('CRAFTON ' + m); };
      T.end(cloudPhase, this.cloudMock ? 'mock' : 'supabase-js');
    });
    this.sessionTask = cloudTask.then(async () => {
      const phase = T.start('session check');
      const ok = await this.account.restore();
      T.end(phase, ok ? 'logged in' : 'no session');
      if (ok) this.prefetchWorlds(); // the world list loads while the menu is still appearing
      return ok;
    }, () => false);
    const soundPhase = T.start('sounds (background)');
    this.audio.prerender().then((n) => T.end(soundPhase, `${n} sounds, never awaited`));
    const atlasPhase = T.start('textures + atlas');
    const sheetPhase = T.start('mob + armor sheets');
    const [, entityTextures] = await Promise.all([
      this.atlas.load().then(() => T.end(atlasPhase, `${TEXTURE_NAMES.length} tiles`)),
      loadEntityTextures().then((m) => { T.end(sheetPhase, `${m.size} sheets`); return m; }),
    ]);
    this.entityTextures = entityTextures;
    this.mobTextures = entityTextures; // same map (mob sheets by name, armor sheets as 'armor/<file>')
    onStep('Building the world…', 0.55);
    const buildPhase = T.start('subsystems + UI');
    const scene = this.renderer.scene;
    this.icons = new BlockIconRenderer(this.atlas); // icons are drawn on demand (hotbar, catalog on first open)
    this.meshManager = new ChunkMeshManager(scene, this.world, this.atlas.texture, this.settings);
    this.chunkManager = new ChunkManager(this.world, this.meshManager, this.settings);
    this.chunkManager.setCutoutBlocks(this.atlas.cutoutBlocks); // blocks whose textures have transparent pixels
    this.sky = new Sky(scene);
    this.sky.setRenderDistance(this.settings.get('renderDistance'));
    this.raycaster = new BlockRaycaster(this.world);
    this.physics = new PlayerPhysics(this.player, this.world, this.events);
    this.controller = new PlayerController(this.player, this.input, this.actions, this.settings);
    this.cameraController = new CameraController(this.renderer.camera, this.player, this.raycaster, this.settings);
    this.selectionBox = new SelectionBox(scene);
    this.breakOverlay = new BreakOverlay(scene, this.atlas.texture);
    this.particles = new ParticleSystem(scene, this.atlas.texture, this.world);
    this.entities = new EntityManager(scene, this.world, this.atlas, this.player, this.inventory, this.events);
    // Flowing water: scheduled updates driven from block changes; plants it floods drop their items.
    this.waterSim = new WaterSimulation(this.world, (x, y, z, id) => this._onWaterDestroys(x, y, z, id));
    this.physics.waterSim = this.waterSim;
    this.entities.waterSim = this.waterSim;
    // Passive mobs (cows, pigs, sheep).
    this.entities.mobs = new MobManager(scene, this.world, this.entityTextures, {
      spawnItem: (x, y, z, id, n) => this.entities.spawnItem(x, y, z, id, n),
      puff: (x, y, z) => this.particles.spawnPuff(x, y, z, 12),
      crit: (x, y, z, halfWidth, height) => { this.particles.spawnCrit(x, y, z, 48, halfWidth, height); this.audio.playAt('player.crit', x, y, z, 'blocks', 0.9); },
      hitPuff: (x, y, z) => this.particles.spawnHitPuff(x, y, z),
      playAt: (name, x, y, z, volume) => this.audio.playAt(name, x, y, z, 'blocks', volume),
      playStep: (blockId, x, y, z) => this.audio.playAt(`${BlockRegistry.soundGroup(blockId)}.step`, x, y, z, 'blocks', 0.15),
    });
    this.entities.mobs.waterSim = this.waterSim;
    this.entities.mobs.setRenderDistance(this.settings.get('renderDistance'));
    // Instant crafting / smelting; results that do not fit drop at the player's feet.
    this.crafting = new CraftingSystem(this.inventory, this.events, (itemId, n) => {
      const p = this.player.position;
      this.entities.spawnItem(p.x, p.y + 0.5, p.z, itemId, n, 0, 0, 0, ITEM_PICKUP_DELAY);
    });
    this.interaction = new BlockInteraction({
      world: this.world, player: this.player, inventory: this.inventory, raycaster: this.raycaster,
      selectionBox: this.selectionBox, breakOverlay: this.breakOverlay, particles: this.particles,
      entities: this.entities, audio: this.audio, events: this.events, actions: this.actions, input: this.input,
      isGuest: () => !!(this.net && !this.net.isHost),
      entityBlocks: (x, y, z) => remotePlayersBlockAt(this.remotePlayers, x, y, z) || mobBlocksAt(this.entities.mobs.mobs, x, y, z),
      canEat: () => this.health.canEat(),
    });
    this.health = new HealthSystem(this);
    this.blockModelMaterial = createBlockModelMaterial(this.atlas.texture, true);
    this.handBlockMaterial = createBlockModelMaterial(this.atlas.texture, false);
    /** [hemisphere, directional]: light the Lambert character materials; the shader pipeline reuses them as sky + sun light. */
    this.modelLights = createModelLights();
    for (const l of this.modelLights) scene.add(l);
    this.playerModel = new PlayerModel(this.blockModelMaterial, this.atlas, this.entityTextures);
    this.playerModel.root.visible = false;
    scene.add(this.playerModel.root);
    this.hand = new FirstPersonHand(this.renderer.handScene, this.handBlockMaterial, this.atlas, this.entityTextures);
    this.remotePlayers = new RemotePlayerManager(this);
    this.interaction.remotePlayers = this.remotePlayers;
    this.ui.init();
    this._wireEvents();
    this.perf = new PerformanceMonitor(this);
    this._applyPerformanceSettings();
    // Voxel lighting (Update #10): everything coloured on the CPU reads the sky light at its position.
    applyBrightness(this.settings.get('brightness'));
    this.lightAt = (x, y, z) => lightFactor(this.world.getSkyLightAt(x, y, z));
    this.entities.lightAt = this.lightAt;
    this.entities.mobs.lightAt = this.lightAt;
    this.particles.lightAt = this.lightAt;
    this.shaders = new ShaderPipeline(this);
    this.shaders.apply();
    this.loop.start();
    T.end(buildPhase);
    await cloudTask; // the account and save manager exist before any screen can need them
  }

  /** Push the Performance options (Update #9 §7) into the loop, entities, water and particles. */
  _applyPerformanceSettings() {
    const s = this.settings;
    this.loop.maxFps = s.get('maxFps');
    const simBlocks = s.get('simulationDistance') * CHUNK_SIZE;
    const entityBlocks = s.get('renderDistance') * CHUNK_SIZE * (s.get('entityDistance') / 100);
    this.entities.mobs.setSimulationDistance(simBlocks);
    this.entities.mobs.setEntityDistance(entityBlocks);
    this.entities.simDistanceBlocks = simBlocks;
    this.entities.entityDistanceBlocks = entityBlocks;
    this.remotePlayers.entityDistanceBlocks = entityBlocks;
    this.waterSim.simRadius = simBlocks;
    this.particles.level = s.get('particles');
  }

  /** Start loading the world list now (login, boot, after Save & Quit); the world menu consumes it with takeWorldList(). */
  prefetchWorlds() {
    if (!this.saveManager) return null;
    const phase = this.timing.start('world list');
    this.worldsPromise = this.saveManager.listWorlds().then((worlds) => { this.timing.end(phase, `${worlds.length} worlds`); return worlds; });
    this.worldsPromise.catch(() => this.timing.end(phase, 'failed'));
    return this.worldsPromise;
  }

  /** The prefetched list if there is one (used once), else a fresh request. */
  takeWorldList() {
    const p = this.worldsPromise || this.saveManager.listWorlds();
    this.worldsPromise = null;
    return p;
  }

  /** Wait for the prefetched list, but never longer than `ms` (the menu must not hang on a slow server). */
  awaitWorldList(ms = 1500) {
    if (!this.worldsPromise) return Promise.resolve();
    return Promise.race([this.worldsPromise.catch(() => null), new Promise((r) => setTimeout(r, ms))]);
  }

  _wireEvents() {
    const ev = this.events;
    ev.on('settings:changed', (key, value) => {
      if (key === 'renderDistance') { this.sky.setRenderDistance(value); this.chunkManager.invalidate(); this.entities.mobs.setRenderDistance(value); this._applyPerformanceSettings(); }
      else if (key === 'smoothLighting' || key === 'fancyLeaves') this.chunkManager.remeshAll();
      else if (key === 'renderScale') { this.renderer.autoScale = 1; this.renderer.resize(); }
      else if (key === 'maxFps' || key === 'simulationDistance' || key === 'entityDistance' || key === 'particles') this._applyPerformanceSettings();
      else if (key === 'shadersOn' || (key.startsWith('sh') && key !== 'shaderPreset' && key !== 'showFps')) this.shaders.apply();
      else if (key === 'brightness') applyBrightness(value); // live: a shader uniform, no re-bake
    });
    ev.on('player:swing', () => { this.hand.swing(); this.playerModel.swing(); });
    ev.on('inventory:selected', () => this._updateHeld());
    ev.on('inventory:changed', () => { this._updateHeld(); this._updateArmor(); });
    ev.on('player:land', (fall) => {
      const under = this._blockUnderPlayer();
      this.audio.playStep(under, Math.min(0.9, 0.35 + fall * 0.08), fall > 3 ? 0.75 : 0.95);
      this.health.onLand(fall);
    });
    ev.on('player:void', () => this.health.onVoid());
    // Multiplayer (Update #9 §8): the host validates its own hits like any guest's; deaths are announced.
    ev.on('player:hitPlayer', (targetId, crit) => { if (this.net && this.net.isHost) this.net.hitPlayer(targetId, crit); });
    ev.on('player:died', (cause) => { if (this.net && this.net.isHost) this.net.announceOwnDeath(cause); });
    // Eating (Update #9 §8): chewing sounds + crumbs of the food's icon from the mouth; healing when done.
    ev.on('player:eating', (itemId) => {
      this.audio.playPlayer('eat', 0.7);
      const item = ItemRegistry.get(itemId);
      const eye = this.player.getEyePosition(this._eye); const dir = this.player.getLookDirection(this._dir);
      if (item) this.particles.spawnItemCrumbs(eye.x + dir.x * 0.5, eye.y - 0.25 + dir.y * 0.5, eye.z + dir.z * 0.5, getTileIndex(item.texture), 4);
    });
    ev.on('player:ate', (itemId, heal) => { this.health.heal(heal); this.audio.playPlayer('eat_done', 0.8); });
    ev.on('player:jump', () => this.audio.playStep(this._blockUnderPlayer(), 0.18));
    ev.on('player:splash', () => this.audio.playPlayer('splash', 0.8));
    ev.on('item:pickup', () => this.audio.playUI('pop', 0.9));
    ev.on('block:changed', (x, y, z) => this.waterSim.onBlockChanged(x, y, z));
    ev.on('chunk:loaded', (cx, cz) => {
      if (this.net && !this.net.isHost) return; // guests: the host owns water flow and mobs
      this.waterSim.onChunkLoaded(cx, cz);
      this.entities.mobs.onChunkLoaded(cx, cz);
      // First generation of this chunk in this world: roll the deterministic mob group.
      const key = chunkKeyString(cx, cz);
      if (!this.session.spawnedChunks.has(key)) {
        this.session.spawnedChunks.add(key);
        const chunk = this.world.getChunk(cx, cz);
        if (chunk) this.entities.mobs.spawnForChunk(this.world.seed, chunk);
      }
    });
    ev.on('chunk:unloading', (cx, cz) => this.entities.mobs.onChunkUnloading(cx, cz));
    ev.on('station:open', (station) => this.openInventory(station));
    ev.on('craft:done', (recipe) => this.audio.playUI(recipe.stations.includes('furnace') ? 'smelt' : 'craft', 0.8));
    ev.on('item:thrown', () => this.audio.playUI('drop', 0.7));
    this.canvas.addEventListener('mousedown', () => {
      if (this.state.is(State.PLAYING) && !this.input.pointerLocked) this.requestPointerLock();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.session.save(false); this._hiddenSince = performance.now(); }
      else this.loop.resetTiming();
      // A hosting tab keeps simulating in the background on a worker ticker (page timers are throttled there).
      this.loop.setHiddenTicker(document.hidden && !!(this.net && this.net.isHost));
    });
    // Async cloud saves cannot finish while the page closes: warn when edits are still unsaved.
    window.addEventListener('beforeunload', (e) => { if (this.session.hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; } });
    // A session that expires or is revoked sends the player back to the account screen.
    ev.on('account:signedout', () => { this._dropNet(); if (this.state.inWorld) this.session.abandon(); if (!this.state.is(State.ACCOUNT)) this.state.set(State.ACCOUNT); });
  }

  // ---- LAN multiplayer (Update #8) ----

  /** True while this tab is a guest on someone else's server. */
  get isGuest() { return !!(this.net && !this.net.isHost); }

  /** Load one of my worlds and host it (Multiplayer → Host Server). */
  async hostWorld(worldId, maxPlayers = MAX_PLAYERS_DEFAULT) {
    const ok = await this.startWorld(worldId);
    if (!ok) return false;
    return this.startHosting(maxPlayers);
  }

  /** Publish the lobby for the world being played; the host plays on as a normal player. */
  async startHosting(maxPlayers = MAX_PLAYERS_DEFAULT) {
    if (this.net || !this.state.inWorld || this.session.remote) return false;
    const host = new HostServer(this, { maxPlayers });
    try { await host.start(); } catch (e) {
      console.warn('Game: hosting failed', e);
      this.ui.hud.showToast("Couldn't publish the server. Check your connection.", false);
      return false;
    }
    this.net = host;
    this.loop.setHiddenTicker(document.hidden);
    this.ui.hud.showToast(`Hosting · code ${host.joinCode} · keep this tab visible while hosting`, false);
    this.ui.pause.refresh();
    this.events.emit('net:changed');
    return true;
  }

  /** Back to single player in the same world; guests see "The host closed the server". */
  stopHosting() {
    if (!this.net || !this.net.isHost) return;
    this.net.stop('stopped');
    this.net = null;
    this.loop.setHiddenTicker(false);
    this.ui.pause.refresh();
    this.events.emit('net:changed');
  }

  /** Join a lobby (Find Server / Join by code): connect, download, generate, play. Errors go back to the Find screen. */
  async joinServer(lobby) {
    if (this.state.inWorld || this.net || this.session.loading) return false;
    const client = new GuestClient(this);
    this.state.set(State.LOADING);
    this.ui.loading.show('Connecting…', { indeterminate: true });
    let welcome;
    try { welcome = await client.connect(lobby); } catch (e) {
      this.state.set(State.MENU);
      this.ui.multiplayer.showFind(e.message || 'Could not connect.');
      return false;
    }
    this.net = client;
    client.onHostClosed = (reason) => this._connectionLost(reason);
    const ok = await this.session.startRemote(client, welcome);
    if (!ok) { this._dropNet(); return false; }
    // The host decides the guest's game mode and whether it may change it (Update #9 §1).
    const you = welcome.you || {};
    client.canChangeMode = !!you.canChangeMode;
    if (this.worldMeta) { this.worldMeta.keepInventory = !!welcome.keepInventory; this.worldMeta.pvp = welcome.pvp !== false; }
    const mode = you.mode || welcome.gameMode;
    if (mode && this.player.gameMode !== mode) this.setGameMode(mode, true);
    this.events.emit('net:changed');
    return true;
  }

  /** Leave the server (pause menu "Leave Server", a lost host, a kick). */
  leaveServer(message = null) {
    const client = this.net;
    if (!client || client.isHost) return;
    this.net = null;
    client.close(true);
    if (this.state.inWorld || this.state.is(State.LOADING)) this.session.abandon();
    if (!this.state.is(State.KICKED)) this.state.set(State.MENU);
    if (message) this.ui.multiplayer.showDisconnected(message);
    this.events.emit('net:changed');
  }

  _connectionLost(reason) {
    if (!this.net || this.net.isHost) return;
    this.leaveServer(reason === 'host closed' ? 'The host closed the server' : 'The connection to the host was lost');
  }

  _dropNet() {
    if (!this.net) return;
    if (this.net.isHost) { this.net.stop('closed'); this.loop.setHiddenTicker(false); }
    else this.net.close(true);
    this.net = null;
    this.events.emit('net:changed');
  }

  /**
   * The account was claimed somewhere else: stop everything, one last best-effort save (3 s), leave any
   * multiplayer session (closing the lobby when hosting) and show the "Signed in somewhere else" screen.
   */
  async onKicked(reason) {
    if (this.kicked) return;
    this.kicked = true;
    console.warn('Game: kicked (' + reason + ')');
    const wasInWorld = this.state.inWorld || this.state.is(State.LOADING);
    const remote = this.session.remote;
    this._dropNet();
    if (wasInWorld && !remote) { try { await this.session.saveWithTimeout(3000); } catch (e) { /* best effort */ } }
    if (wasInWorld) this.session.abandon();
    this.input.exitPointerLock();
    this.state.set(State.KICKED);
  }

  /** Reconnect from the kick screen: claim the account again (kicking the other place) and return to the menu. */
  async reconnect() {
    const ok = await this.sessionGuard.claim();
    if (!ok) { this.ui.multiplayer.setKickedError("Couldn't reach the server. Try again."); return false; }
    this.kicked = false;
    this.prefetchWorlds();
    this.state.set(State.MENU);
    return true;
  }

  /** Worn armor on the third-person model and the first-person arm. */
  _updateArmor() {
    const worn = this.inventory.armorMaterials();
    this.playerModel.setArmor(worn);
    this.hand.setArmor(worn);
  }

  _updateHeld() {
    const s = this.inventory.getSelected();
    const id = s ? s.itemId : 0;
    this.hand.setHeldItem(id);
    this.playerModel.setHeldItem(id);
  }

  /** Water flowed into a plant: drop its item and show particles. */
  _onWaterDestroys(x, y, z, blockId) {
    this.particles.spawnBlockBreak(x, y, z, blockId, 6);
    const dropName = BlockRegistry.dropName(blockId);
    const dropId = dropName ? ItemRegistry.idOf(dropName) : -1;
    if (dropId >= 0) this.entities.spawnItem(x + 0.5, y + 0.3, z + 0.5, dropId, 1);
  }

  _blockUnderPlayer() {
    const p = this.player.position;
    return this.world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.05), Math.floor(p.z));
  }

  // ---- State transitions ----

  startWorld(worldId) { return this.session.start(worldId); }

  requestPointerLock() { this.input.requestPointerLock(); }

  pause() {
    if (!this.state.is(State.PLAYING)) return;
    this.state.set(State.PAUSED);
    this.input.exitPointerLock();
  }

  /**
   * Back to the game. `lock` is false when a key (Esc) closed the menu: browsers refuse pointer lock right after
   * Esc (about a 1 s cooldown and no user activation), so the game resumes unlocked behind a small "Click to
   * resume" overlay and the next click captures the mouse. The Resume button (a click) locks immediately.
   */
  resume(lock = true) {
    if (this.state.is(State.PAUSED)) { this.state.set(State.PLAYING); if (lock) this.requestPointerLock(); }
    else if (this.state.is(State.INVENTORY)) this.closeInventory(lock);
  }

  /** @param {'inventory'|'crafting_table'|'furnace'} station recipe list to show */
  openInventory(station = 'inventory') {
    if (!this.state.is(State.PLAYING)) return;
    if (this.player.isSpectator && station !== 'inventory') return; // spectators cannot use stations
    this.expectUnlock = true;
    this.input.exitPointerLock();
    this.state.set(State.INVENTORY);
    this.ui.inventory.open(station);
    this.audio.playUI('inv_open');
  }

  closeInventory(lock = true) {
    if (!this.state.is(State.INVENTORY)) return;
    this.ui.inventory.close();
    this.state.set(State.PLAYING);
    this.audio.playUI('inv_close');
    if (lock) this.requestPointerLock();
  }

  /** Survival → Creative → Spectator → Survival. */
  cycleGameMode() {
    const i = GAME_MODE_ORDER.indexOf(this.player.gameMode);
    this.setGameMode(GAME_MODE_ORDER[(i + 1) % GAME_MODE_ORDER.length]);
  }

  /** @deprecated use cycleGameMode */
  toggleGameMode() { this.cycleGameMode(); }

  /** `forced` is the host's decision (the WELCOME or a MODE message); a guest cannot change its own mode without permission. */
  setGameMode(mode, forced = false) {
    if (!forced && this.isGuest && !this.net.canChangeMode) { this.ui.hud.showMessage('The host controls your game mode.'); return false; }
    const p = this.player;
    const wasSpectator = p.isSpectator;
    p.gameMode = mode;
    if (p.isSpectator) { p.flying = true; p.velocity.set(0, 0, 0); }
    else if (!p.isCreative) p.flying = false;
    if (wasSpectator && !p.isSpectator) this._unbury();
    if (this.worldMeta) this.worldMeta.gameMode = mode;
    this.session.gameModeChanged(mode);
    this.ui.hud.showMessage(`Game Mode: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
    this.events.emit('gamemode:changed', mode);
  }

  /** Leaving Spectator inside blocks: move up to the nearest free space that fits the hitbox. */
  _unbury() {
    const p = this.player;
    p.updateAABB();
    for (let i = 0; i < 256 && intersectsSolid(this.world, p.aabb); i++) {
      p.teleport(p.position.x, Math.floor(p.position.y) + 1, p.position.z);
      p.updateAABB();
    }
  }

  /** Save & Quit (or Leave Server): the pause menu freezes (spinner on the button) and the "Saving…" overlay shows at once. */
  async saveAndQuit() {
    this.ui.pause.setBusy(true);
    try {
      if (this.isGuest) { this.leaveServer(); return; }
      if (this.net && this.net.isHost) this.stopHosting();
      await this.session.quit();
    } finally { this.ui.pause.setBusy(false); }
  }

  /** Log out: leave the world (saving) first, then return to the account screen. */
  async logout() {
    if (this.isGuest) this.leaveServer();
    if (this.net && this.net.isHost) this.stopHosting();
    if (this.state.inWorld) { const left = await this.session.quit(); if (!left) return; }
    if (this.sessionGuard) this.sessionGuard.release();
    this.kicked = false;
    await this.account.signOut();
    this.state.set(State.ACCOUNT);
  }

  // ---- Per-frame input dispatch ----

  _handleKeys() {
    const a = this.actions;
    const st = this.state;
    if (this.input.capturing) return; // the Controls screen is recording a key
    if (a.wasPressed('debug')) this.ui.debug.toggle();
    if (a.wasPressed('atlasDebug')) this.ui.toggleAtlasView();
    const escape = this.input.wasPressed(PAUSE_CODE);
    // Esc closes the topmost menu screen first (Controls, then Options), wherever it was opened from.
    if (escape && this.ui.controls.isOpen) { this.ui.controls.close(); return; }
    if (escape && this.ui.options.isOpen) { this.ui.options.close(); return; }
    if (escape && this.ui.shaders.isOpen) { this.ui.shaders.close(); return; }
    if (!st.inWorld) return;
    // Esc while the mouse is locked makes the browser release the lock, and that release opens the pause menu
    // (UIManager._onPointerLock). Esc on an open screen closes it without a lock request (Update #9): the game
    // resumes behind the "Click to resume" overlay. Esc while playing unlocked does nothing; the menu never
    // reopens on its own.
    if (escape) {
      if (st.is(State.INVENTORY)) this.closeInventory(false);
      else if (st.is(State.PAUSED)) this.resume(false);
    }
    if (a.wasPressed('inventory')) {
      if (st.is(State.PLAYING)) this.openInventory();
      else if (st.is(State.INVENTORY)) this.closeInventory(false);
    }
    if (!st.is(State.PLAYING)) return;
    if (a.wasPressed('perspective')) this.cameraController.cycle();
    if (a.wasPressed('toggleGameMode')) this.cycleGameMode();
    const wheel = this.input.consumeWheel();
    if (this.player.isSpectator) {
      // Spectator: the wheel changes the fly speed instead of the hotbar slot.
      if (wheel !== 0) {
        const p = this.player;
        p.spectatorSpeed = Math.min(SPECTATOR_SPEED_MAX, Math.max(SPECTATOR_SPEED_MIN, p.spectatorSpeed * (wheel < 0 ? SPECTATOR_SPEED_STEP : 1 / SPECTATOR_SPEED_STEP)));
        this.ui.hud.showMessage(`Fly speed ${p.spectatorSpeed.toFixed(2)}×`);
      }
      return;
    }
    for (let i = 1; i <= 9; i++) if (a.wasPressed('hotbar' + i)) this.inventory.setSelectedIndex(i - 1);
    if (wheel !== 0) this.inventory.setSelectedIndex(this.inventory.selectedIndex + wheel);
    if (a.wasPressed('drop')) {
      const stack = this.inventory.getSelected();
      if (stack) {
        const n = a.isActive('sprint') ? stack.count : 1; // sprint key doubles as the whole-stack modifier
        const taken = this.inventory.removeFromSlot(this.inventory.selectedIndex, n);
        if (taken) { this.entities.throwFromPlayer(taken.itemId, taken.count); this.events.emit('player:swing'); }
      }
    }
  }

  /** Soft stroke sound every ~0.6 s while sprint-swimming. */
  _swimSounds(dt) {
    const p = this.player;
    if (!p.swimming) { this._swimTimer = 0; return; }
    this._swimTimer -= dt;
    if (this._swimTimer <= 0) {
      this._swimTimer = SWIM_STROKE_INTERVAL;
      this.audio.playPlayer('swim', 0.45);
    }
  }

  _footsteps() {
    const p = this.player;
    if (!p.onGround || p.flying || p.inWater || p.sneaking && p.horizontalSpeed < 0.5) { this._lastStepDistance = p.walkDistance; return; }
    const interval = p.sprinting ? STEP_DISTANCE * 0.8 : STEP_DISTANCE;
    if (p.walkDistance - this._lastStepDistance >= interval) {
      this._lastStepDistance = p.walkDistance;
      this.audio.playStep(this._blockUnderPlayer(), p.sprinting ? 0.33 : 0.27);
    }
  }

  // ---- Loop ----

  fixedUpdate(dt) {
    if (!this.state.simulating) return;
    if (!this.player.dead) this.physics.step(dt); // a dead player's body waits for Respawn
    this.entities.fixedUpdate(dt);
    // Scheduled water updates every WATER_TICK_SECONDS (only blocks touched by a change are processed); the host
    // of a LAN server runs them for everyone, guests only mirror.
    this._waterTimer += dt;
    if (this._waterTimer >= WATER_TICK_SECONDS) {
      this._waterTimer -= WATER_TICK_SECONDS;
      if (!this.isGuest) { this.waterSim.setSimulationCenter(this.player.position.x, this.player.position.z); this.waterSim.tick(); }
    }
  }

  frame(alpha, dt) {
    const hosting = !!(this.net && this.net.isHost);
    const hidden = document.hidden && !this.ignoreHidden;
    if (hidden && !hosting) { this.input.endFrame(); return; } // a hosting tab keeps simulating (but does not draw)
    this._handleKeys();
    const st = this.state;
    if (st.inWorld) {
      const playing = st.is(State.PLAYING);
      const p = this.player;
      this.controller.enabled = playing && this.input.pointerLocked;
      this.controller.updateLook();
      this.controller.updateIntent();
      p.interpolate(alpha);
      this.cameraController.update(dt);
      const first = this.cameraController.isFirstPerson;
      p.getEyePosition(this._eye);
      p.getLookDirection(this._dir);
      const spectator = p.isSpectator;
      this.interaction.enabled = playing && !spectator;
      this.interaction.update(dt, this._eye.x, this._eye.y, this._eye.z, this._dir.x, this._dir.y, this._dir.z);
      this.chunkManager.update(p.position.x, p.position.z, this._dir.x, this._dir.z);
      this.entities.render(alpha, dt);
      this.particles.update(dt, this.renderer.camera);
      this.hand.visible = first && !spectator && !p.dead;
      this.hand.eating = this.interaction.eatProgress;
      this.hand.setLight(this.lightAt(this._eye.x, this._eye.y, this._eye.z));
      this.hand.update(dt, p, this.cameraController.bobPhase, this.cameraController.handBobFactor);
      this.health.update(dt);
      this.playerModel.root.visible = !first && !spectator;
      if (!first && !spectator) { this.playerModel.setLight(this.lightAt(p.renderPosition.x, p.renderPosition.y + 1, p.renderPosition.z)); this.playerModel.update(dt, p); }
      this.ui.hud.setHotbarVisible(!spectator && !this.state.is(State.INVENTORY));
      this.sky.setUnderwater(p.headInWater);
      this.sky.update(this.renderer.camera);
      this.audio.update(dt, this.renderer.camera, p, this.world);
      this._footsteps();
      this._swimSounds(dt);
      this.ui.hud.setCrosshairVisible(this.cameraController.perspective !== Perspective.THIRD_FRONT);
      this.session.update(dt);
      if (this.net) this.net.update(dt);
      this.remotePlayers.update(dt);
      this.perf.update(dt);
      this.renderer.handVisible = first;
      this.shaders.update(dt);
      if (!hidden) this.renderer.render();
      if (this.afterRender) this.afterRender();
    } else if (st.is(State.LOADING)) {
      // Keep the sky/scene warm; nothing else to draw.
    }
    this.ui.update(dt);
    this.input.endFrame();
  }
}
