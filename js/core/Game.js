// Game.js — owns every subsystem, wires them together, and runs the per-frame / fixed-step logic.

import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Settings } from './Settings.js';
import { GameState, State } from './GameState.js';
import { GameLoop } from './GameLoop.js';
import { WorldSession } from './WorldSession.js';
import { InputManager } from '../input/InputManager.js';
import { ActionMap } from '../input/ActionMap.js';
import { PointerLockController } from '../input/PointerLockController.js';
import { KeyBindingStore } from './KeyBindingStore.js';
import { PAUSE_CODE, CHAT_ENTER_CODE, CHAT_SLASH_CODE } from '../config/KeyBindings.js';
import { createCommands } from '../commands/index.js';
import { TICK_RATE_DEFAULT, TICK_RATE_MIN, TICK_RATE_MAX } from '../config/Constants.js';
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
import { applyBrightness, lightColor } from '../rendering/LightUniforms.js';
import { TorchEffects } from '../rendering/TorchEffects.js';
import { getTileIndex } from '../rendering/AtlasLayout.js';
import { CHUNK_SIZE } from '../config/Constants.js';
import { MAX_PLAYERS_DEFAULT, RejectReason } from '../net/Protocol.js';
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
import { SWIM_STROKE_INTERVAL, WATER_TICK_SECONDS, LAVA_TICK_SECONDS, ITEM_PICKUP_DELAY } from '../config/Constants.js';
import { WaterSimulation, LIQUID_KINDS } from '../world/WaterSimulation.js';
import { CraftingSystem } from '../crafting/CraftingSystem.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { Profiler } from './Profiler.js';
import { ChunkVisibility } from '../rendering/Visibility.js';
import { Benchmark } from './Benchmark.js';

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
    /** Per-system main-thread timers (Update #14 §0): the F3 graph and the benchmark read them. */
    this.profiler = new Profiler();
    this.bench = new Benchmark(this);
    this.settings = new Settings(this.events);
    this.state = new GameState(this.events);
    this.input = new InputManager(canvas, this.events);
    /** The one owner of the mouse lock (Update #13 §1); the input manager mirrors it and reports user activation. */
    this.lock = new PointerLockController(this.canvas, this.events);
    this.input.lock = this.lock;
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
    this.loop = new GameLoop((dt) => this.fixedUpdate(dt), (alpha, gameDt, realDt) => this.frame(alpha, gameDt, realDt));
    this.loop.isSimulating = () => this.state.simulating;
    this.loop.onFrameEnd = (interval, cpu) => { this.profiler.endFrame(interval, cpu); this.bench.record(interval, cpu); };
    this.world.profiler = this.profiler;
    this.renderer.profiler = this.profiler;
    /** /tick (Update #12): Minecraft's scale, 20 = normal; never saved, reset when a world loads. */
    this.tick = { rate: TICK_RATE_DEFAULT, frozen: false };
    this.commands = createCommands(this);
    this.worldMeta = null;
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._lastStepDistance = 0;
    this._swimTimer = 0;
    this._waterTimer = 0;
    this._lavaTimer = 0;
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
    this.meshManager = new ChunkMeshManager(scene, this.world, this.atlas, this.settings);
    this.visibility = new ChunkVisibility(this.meshManager); // cave culling (Update #14 §2c)
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
    // Lava (Update #11): the same scheduler at a slower tick; lava meeting water sizzles into cobblestone.
    this.lavaSim = new WaterSimulation(this.world, (x, y, z, id) => this._onWaterDestroys(x, y, z, id), LIQUID_KINDS.lava);
    this.waterSim.onConvert = this.lavaSim.onConvert = (x, y, z) => this._sizzle(x + 0.5, y + 0.5, z + 0.5);
    this.entities.onBurn = (x, y, z) => this._sizzle(x, y, z);
    // Passive mobs (cows, pigs, sheep).
    this.entities.mobs = new MobManager(scene, this.world, this.entityTextures, {
      spawnItem: (x, y, z, id, n) => this.entities.spawnItem(x, y, z, id, n),
      puff: (x, y, z) => this.particles.spawnPuff(x, y, z, 12),
      crit: (x, y, z, halfWidth, height) => { this.particles.spawnCrit(x, y, z, 48, halfWidth, height); this.audio.playAt('player.crit', x, y, z, 'blocks', 0.9); },
      hitPuff: (x, y, z) => this.particles.spawnHitPuff(x, y, z),
      playAt: (name, x, y, z, volume) => this.audio.playAt(name, x, y, z, 'blocks', volume),
      playStep: (blockId, x, y, z) => this.audio.playAt(`${BlockRegistry.soundGroup(blockId)}.step`, x, y, z, 'blocks', 0.15),
      flame: (x, y, z, n) => this.particles.spawnFlame(x, y, z, n, 0.3, 0.9),
    });
    this.entities.mobs.waterSim = this.waterSim;
    this.entities.mobs.setRenderDistance(this.settings.get('renderDistance'));
    // Natural respawns (Update #12 §5d) keep away from every player: the local one and, when hosting, the guests.
    this.entities.mobs.playerPositions = () => {
      const p = this.player, out = [{ x: p.position.x, y: p.position.y, z: p.position.z, dirX: -Math.sin(p.yaw), dirZ: -Math.cos(p.yaw) }];
      if (this.remotePlayers) for (const rp of this.remotePlayers.players.values()) { const o = rp.state && rp.state.renderPosition ? rp.state.renderPosition : null; if (o) out.push({ x: o.x, y: o.y, z: o.z, dirX: -Math.sin(rp.state.yaw || 0), dirZ: -Math.cos(rp.state.yaw || 0) }); }
      return out;
    };
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
    // (x, y, z) → [r, g, b] factors of the sky light and the warm block light there (Updates #10 / #11); one shared array,
    // consumers apply it at once.
    this._lightRGB = [1, 1, 1];
    this.lightAt = (x, y, z) => { const b = this.world.getLightByteAt(x, y, z); return lightColor(b & 15, b >> 4, this._lightRGB); };
    this.torchEffects = new TorchEffects(this.world, this.particles);
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
    this.waterSim.simRadius = simBlocks; this.lavaSim.simRadius = simBlocks;
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
      else if (key === 'renderScale' || key === 'hiDpi') { this.renderer.autoScale = 1; this.renderer.resize(); }
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
    ev.on('block:changed', (x, y, z) => { if (this.isGuest) return; this.waterSim.onBlockChanged(x, y, z); this.lavaSim.onBlockChanged(x, y, z); }); // guests only mirror the host's flow
    ev.on('chunk:loaded', (cx, cz) => {
      if (this.net && !this.net.isHost) return; // guests: the host owns water flow and mobs
      this.waterSim.onChunkLoaded(cx, cz);
      this.lavaSim.onChunkLoaded(cx, cz); // lava flow parked at an unloaded chunk border resumes too
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
      if (this.state.is(State.PLAYING) && !this.lock.locked && !this.ui.chat.isOpen) this.requestPointerLock('canvas');
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

  /** Load one of my worlds and host it (Multiplayer → Host New Server). `opts`: { maxPlayers, visibility } or just the player limit. */
  async hostWorld(worldId, opts = MAX_PLAYERS_DEFAULT) {
    const ok = await this.startWorld(worldId);
    if (!ok) return false;
    return this.startHosting(opts);
  }

  /** Publish the lobby for the world being played; the host plays on as a normal player. `opts`: { maxPlayers, visibility } or the player limit. */
  async startHosting(opts = MAX_PLAYERS_DEFAULT) {
    if (this.net || !this.state.inWorld || this.session.remote) return false;
    const options = typeof opts === 'number' ? { maxPlayers: opts } : { ...(opts || {}) };
    const host = new HostServer(this, options);
    try { await host.start(); } catch (e) {
      console.warn('Game: hosting failed', e);
      this.ui.hud.showToast("Couldn't publish the server. Check your connection.", false);
      return false;
    }
    this.net = host;
    this.loop.setHiddenTicker(document.hidden);
    this.ui.hud.showToast(`Hosting (${host.visibility}) · code ${host.joinCode} · keep this tab visible while hosting`, false);
    this.systemChat(`Hosting a ${host.visibility} server · join code ${host.joinCode}`, 'gray', false);
    this.ui.pause.refresh();
    this._netChanged();
    return true;
  }

  /** Back to single player in the same world; guests see "The host closed the server". */
  stopHosting() {
    if (!this.net || !this.net.isHost) return;
    this.net.stop('stopped');
    this.net = null;
    this.loop.setHiddenTicker(false);
    this.ui.pause.refresh();
    this._netChanged();
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
    this._netChanged();
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
    this._netChanged();
  }

  _connectionLost(reason) {
    if (!this.net || this.net.isHost) return;
    const text = reason === 'host closed' ? 'The host closed the server'
      : reason === 'kicked' ? RejectReason.KICKED
        : reason === 'banned' ? RejectReason.BANNED
          : 'The connection to the host was lost';
    this.leaveServer(text);
  }

  _dropNet() {
    if (!this.net) return;
    if (this.net.isHost) { this.net.stop('closed'); this.loop.setHiddenTicker(false); }
    else this.net.close(true);
    this.net = null;
    this._netChanged();
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
    this.lock.release('kicked');
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
  /** Lava met water, or an item burned (Update #11): a hiss and a little smoke. */
  _sizzle(x, y, z) {
    this.audio.playAt('lava.sizzle', x, y, z, 'blocks', 0.8);
    this.particles.spawnSmoke(x, y + 0.4, z, 5, 1.3);
  }

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

  /** Ask the lock controller for the mouse; `source` is for the ?debuglog trace. */
  requestPointerLock(source = 'game') { return this.lock.request(source); }

  pause() {
    if (!this.state.is(State.PLAYING)) return;
    if (this.ui.chat && this.ui.chat.isOpen) this.ui.chat.close(false);
    this.state.set(State.PAUSED);
    this.lock.release('pause');
  }

  /**
   * Back to the game. `lock` is false when Esc closed the menu: Esc is not user activation, so the lock is requested on
   * the next key press or click instead (Update #12 §3c); a click (the Resume button) or a key such as E locks at once.
   * In single player the world was paused, so the loop's timing restarts without catching up.
   */
  resume(lock = true) {
    if (this.state.is(State.PAUSED)) {
      this.state.set(State.PLAYING);
      this.loop.resetTiming();
      if (lock) this.requestPointerLock('resume'); else this.lock.relockOnNextInput();
    } else if (this.state.is(State.INVENTORY)) this.closeInventory(lock);
  }

  /** @param {'inventory'|'crafting_table'|'furnace'} station recipe list to show */
  openInventory(station = 'inventory') {
    if (!this.state.is(State.PLAYING)) return;
    if (this.player.isSpectator && station !== 'inventory') return; // spectators cannot use stations
    if (this.ui.chat.isOpen) this.ui.chat.close(false);
    this.lock.release('inventory');
    this.state.set(State.INVENTORY);
    this.ui.inventory.open(station);
    this.audio.playUI('inv_open');
  }

  closeInventory(lock = true) {
    if (!this.state.is(State.INVENTORY)) return;
    this.ui.inventory.close();
    this.state.set(State.PLAYING);
    this.audio.playUI('inv_close');
    if (lock) this.requestPointerLock('inventory-close'); else this.lock.relockOnNextInput();
  }

  // ---- Chat and commands (Update #12) ----

  /** Chat box: `prefill` '/' when the slash key opened it. */
  openChat(prefill = '') {
    if (!this.state.is(State.PLAYING) || this.ui.chat.isOpen) return;
    this.ui.chat.open(prefill);
  }

  /** The chat box closed: Enter (a key press, user activation) re-locks now; Esc re-locks on the next key or click. */
  onChatClosed(viaKey) {
    if (!this.state.is(State.PLAYING)) return;
    if (viaKey) this.requestPointerLock('chat-enter'); else this.lock.relockOnNextInput();
  }

  /** A chat line typed by this player: shown locally (single player / host) and sent to everyone; guests send it to the host. */
  sendChat(text) {
    const name = (this.account && this.account.username) || (this.net ? this.net.name : null) || 'you';
    if (this.isGuest) { this.net.sendChat(text); return; }
    this.ui.chat.add({ name, text, host: !!this.net });
    if (this.net) this.net.broadcastChat(name, text, true);
  }

  /** A system line (joins, leaves, deaths): shown here and, when hosting, sent to every guest. */
  systemChat(text, color = 'yellow', broadcast = true) {
    this.ui.chat.system(text, color);
    if (broadcast && this.net && this.net.isHost) this.net.broadcastSystem(text, color);
  }

  // ---- /tick (Update #12): game speed on Minecraft's 20-ticks-per-second scale ----

  setTickRate(rate, fromHost = false) {
    rate = Math.min(TICK_RATE_MAX, Math.max(TICK_RATE_MIN, Math.round(rate)));
    this.tick.rate = rate;
    this.loop.setTickRate(rate);
    this.audio.setTimeScale(this.tick.frozen ? 0 : rate / TICK_RATE_DEFAULT);
    this._tickChanged(fromHost);
  }

  setTickFrozen(frozen, fromHost = false) {
    frozen = !!frozen;
    if (this.tick.frozen === frozen && this.loop.frozen === frozen) return;
    this.tick.frozen = frozen;
    this.loop.frozen = frozen;
    if (!frozen) this.loop.resetTiming();
    this.audio.setTimeScale(frozen ? 0 : this.tick.rate / TICK_RATE_DEFAULT);
    this._tickChanged(fromHost);
  }

  /** /tick step: advance whole ticks (1/20 s each) while frozen. */
  stepTicks(n = 1) { this.loop.stepTicks(n); }

  /** A world loads: back to normal speed (the rate is never saved). */
  resetTick() { this.tick.rate = TICK_RATE_DEFAULT; this.tick.frozen = false; this.loop.setTickRate(TICK_RATE_DEFAULT); this.loop.frozen = false; this.loop.pendingGameTime = 0; this.audio.setTimeScale(1); this._tickChanged(true); }

  _tickChanged(fromHost) {
    if (this.ui.hud) this.ui.hud.setTickBadge(this.tick);
    if (!fromHost && this.net && this.net.isHost) this.net.broadcastTick(this.tick);
    this.events.emit('tick:changed', this.tick);
  }

  /** The pause menu is only an overlay in multiplayer (the host's simulation never stops, guests keep mirroring). */
  _netChanged() {
    this.state.overlayPause = !!this.net;
    this.events.emit('net:changed');
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
      else if (st.is(State.INVENTORY)) this.closeInventory(true); // closing with the key re-locks at once (Update #12 §3c)
    }
    if (!st.is(State.PLAYING)) return;
    // Chat (Update #12): the bindable key, Enter, or "/" with a slash already typed. While the box is open the input
    // element has focus, so no game key reaches here.
    if (!this.ui.chat.isOpen) {
      if (a.wasPressed('chat') || this.input.wasPressed(CHAT_ENTER_CODE)) { this.openChat(''); return; }
      if (this.input.wasPressed(CHAT_SLASH_CODE)) { this.openChat('/'); return; }
    }
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
    const pr = this.profiler;
    pr.begin('physics');
    if (!this.player.dead) this.physics.step(dt); // a dead player's body waits for Respawn
    pr.end('physics');
    pr.begin('mobs');
    this.entities.fixedUpdate(dt);
    pr.end('mobs');
    // Scheduled water updates every WATER_TICK_SECONDS (only blocks touched by a change are processed); the host
    // of a LAN server runs them for everyone, guests only mirror.
    this._waterTimer += dt;
    if (this._waterTimer >= WATER_TICK_SECONDS) {
      this._waterTimer -= WATER_TICK_SECONDS;
      if (!this.isGuest) { pr.begin('water'); this.waterSim.setSimulationCenter(this.player.position.x, this.player.position.z); this.waterSim.tick(); pr.end('water'); }
    }
    this._lavaTimer += dt;
    if (this._lavaTimer >= LAVA_TICK_SECONDS) {
      this._lavaTimer -= LAVA_TICK_SECONDS;
      if (!this.isGuest) { pr.begin('lava'); this.lavaSim.setSimulationCenter(this.player.position.x, this.player.position.z); this.lavaSim.tick(); pr.end('lava'); }
    }
  }

  /**
   * Per frame. `dt` is game time (scaled by /tick, 0 while paused or frozen) for everything that moves or animates;
   * `realDt` is wall-clock time for the UI, autosave, networking and the performance monitor. Mouse look uses the raw
   * mouse delta, so it is never scaled.
   */
  frame(alpha, dt, realDt = dt) {
    const hosting = !!(this.net && this.net.isHost);
    const hidden = document.hidden && !this.ignoreHidden;
    if (hidden && !hosting) { this.input.endFrame(); return; } // a hosting tab keeps simulating (but does not draw)
    this._handleKeys();
    const st = this.state;
    const pr = this.profiler;
    if (st.inWorld) {
      const playing = st.is(State.PLAYING);
      const p = this.player;
      if (this.bench.active) this.bench.update(realDt);
      pr.begin('misc');
      this.controller.enabled = playing && this.input.pointerLocked && !this.ui.chat.isOpen;
      this.controller.updateLook();
      this.controller.updateIntent();
      p.interpolate(alpha);
      this.cameraController.update(dt);
      const first = this.cameraController.isFirstPerson;
      p.getEyePosition(this._eye);
      p.getLookDirection(this._dir);
      const spectator = p.isSpectator;
      this.interaction.enabled = playing && !spectator && !this.ui.chat.isOpen;
      pr.end('misc');
      pr.begin('interaction');
      this.interaction.update(dt, this._eye.x, this._eye.y, this._eye.z, this._dir.x, this._dir.y, this._dir.z);
      pr.end('interaction');
      this.chunkManager.update(p.position.x, p.position.z, this._dir.x, this._dir.z);
      pr.begin('culling');
      this.visibility.update(this.renderer.camera, Math.floor(p.position.x) >> 4, Math.floor(p.position.z) >> 4, this.chunkManager.renderDistance);
      pr.end('culling');
      pr.begin('mobs');
      this.entities.render(alpha, dt, this.visibility.enabled ? this.visibility.frustum : null);
      pr.end('mobs');
      pr.begin('torches');
      this.torchEffects.update(dt, p.position.x, p.position.y, p.position.z);
      pr.end('torches');
      pr.begin('particles');
      this.particles.update(dt, this.renderer.camera);
      pr.end('particles');
      pr.begin('misc');
      this.hand.visible = first && !spectator && !p.dead;
      this.hand.eating = this.interaction.eatProgress;
      this.hand.setLight(this.lightAt(this._eye.x, this._eye.y, this._eye.z));
      this.hand.update(dt, p, this.cameraController.bobPhase, this.cameraController.handBobFactor);
      this.health.update(dt);
      this.playerModel.root.visible = !first && !spectator;
      if (!first && !spectator) { this.playerModel.setLight(this.lightAt(p.renderPosition.x, p.renderPosition.y + 1, p.renderPosition.z)); this.playerModel.update(dt, p); }
      this.ui.hud.setHotbarVisible(!spectator && !this.state.is(State.INVENTORY));
      this.sky.setLiquid(p.headInLava ? 'lava' : p.headInWater ? 'water' : null);
      if (p.onFire && !p.dead && !spectator) this.particles.spawnFlame(p.renderPosition.x, p.renderPosition.y + 0.9, p.renderPosition.z, first ? 1 : 2, 0.35, 0.9); // burning (Update #11)
      this.sky.update(this.renderer.camera);
      this.audio.update(dt, this.renderer.camera, p, this.world);
      this._footsteps();
      this._swimSounds(dt);
      this.ui.hud.setCrosshairVisible(this.cameraController.perspective !== Perspective.THIRD_FRONT);
      pr.end('misc');
      pr.begin('autosave');
      this.session.update(realDt);   // autosave stays on real time
      pr.end('autosave');
      pr.begin('net');
      if (this.net) this.net.update(realDt);
      this.remotePlayers.update(dt);
      pr.end('net');
      pr.begin('misc');
      this.perf.update(realDt);
      this.renderer.handVisible = first;
      this.shaders.update(dt);
      pr.end('misc');
      pr.begin('render');
      if (!hidden) this.renderer.render();
      pr.end('render');
      if (this.afterRender) this.afterRender();
    } else if (st.is(State.LOADING)) {
      // Keep the sky/scene warm; nothing else to draw.
    }
    pr.begin('ui');
    this.ui.update(realDt); // UI fades are real-time
    pr.end('ui');
    this.input.endFrame();
  }
}
