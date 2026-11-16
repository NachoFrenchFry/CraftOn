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
import { PAUSE_CODE, CHAT_ENTER_CODE, CHAT_SLASH_CODE, DROP_STACK_MODIFIERS } from '../config/KeyBindings.js';
import { createCommands } from '../commands/index.js';
import { LOCATE_MAX_DISTANCE } from '../generation/Locate.js';
import { TICK_RATE_DEFAULT, TICK_RATE_MIN, TICK_RATE_MAX, EXPLOSION_KNOCKBACK, ROCKET_SECONDS, ROCKET_COOLDOWN, ROCKET_DASH_SECONDS, ROCKET_DASH_COOLDOWN, ROCKET_DASH_SPEED } from '../config/Constants.js';
import { Renderer, msaaSamplesOf } from '../rendering/Renderer.js';
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
import { BoatManager } from '../entities/BoatManager.js';
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
import { MAX_PLAYERS_DEFAULT, MAX_PLAYERS_MAX, RejectReason } from '../net/Protocol.js';
import { worldSetting, lockedModeOf, lockedText, modeName, BADGE_SENTENCE, OFFLINE_TEXT, NO_CHEATS_TEXT } from './WorldSettings.js';
import { Presence } from './Presence.js';
import { MOB_BY_TYPE } from '../entities/mobs/MobSpawner.js';
import { WORLD_HEIGHT } from '../config/Constants.js';
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
import { zombieDamage, armorReduction, arrowPlayerDamage, explosionPlayerDamage } from '../player/Damage.js';
import { ItemIds } from '../items/ItemDefinitions.js';
import { ChestManager } from '../items/ChestManager.js';
import { INVENTORY_SIZE } from '../items/Inventory.js';
import { EntityManager } from '../entities/EntityManager.js';
import { AudioManager } from '../audio/AudioManager.js';
import { UIManager } from '../ui/UIManager.js';
import { GuiScale } from '../ui/GuiScale.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { SWIM_STROKE_INTERVAL, WATER_TICK_SECONDS, LAVA_TICK_SECONDS, ITEM_PICKUP_DELAY, PLAYER_DEATH_SECONDS } from '../config/Constants.js';
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
    /** Per-system main-thread timers: the F3 graph and the benchmark read them. */
    this.profiler = new Profiler();
    this.bench = new Benchmark(this);
    this.settings = new Settings(this.events);
    this.state = new GameState(this.events);
    this.input = new InputManager(canvas, this.events);
    /** The one owner of the mouse lock; the input manager mirrors it and reports user activation. */
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
    /** One place per account: claims, heartbeat, kick. Created with the account in boot(). */
    this.sessionGuard = null;
    this.kicked = false;
    /** LAN multiplayer: a HostServer while hosting, a GuestClient while joined, else null. */
    this.net = null;
    this.remotePlayers = null;
    this.networkInfo = null;
    /** Prefetched world list (Game.prefetchWorlds) consumed by the world menu. */
    this.worldsPromise = null;
    this.inventory = new Inventory(this.events);
    this.player = new Player();
    this.session = new WorldSession(this);
    /** What I am doing, for my friends (presence_beat every 30 s while logged in; part 4). */
    this.presence = new Presence(this);
    this.ui = new UIManager(this);
    this.loop = new GameLoop((dt) => this.fixedUpdate(dt), (alpha, gameDt, realDt) => this.frame(alpha, gameDt, realDt));
    this.loop.isSimulating = () => this.state.simulating;
    this.loop.onFrameEnd = (interval, cpu) => { this.profiler.endFrame(interval, cpu); this.bench.record(interval, cpu); };
    this.world.profiler = this.profiler;
    this.renderer.profiler = this.profiler;
    /** /tick: Minecraft's scale, 20 = normal; never saved, reset when a world loads. */
    this.tick = { rate: TICK_RATE_DEFAULT, frozen: false };
    this.commands = createCommands(this);
    /** The structure names of structures/index.json (for /locate and its suggestions); loaded once in the background. */
    this.structureNames = [];
    fetch('structures/index.json', { cache: 'reload' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && Array.isArray(j.structures)) this.structureNames = j.structures.map((f) => String(f).replace(/\.json$/, '')).sort(); }).catch(() => {});
    this.worldMeta = null;
    /** A HostServer.start() in progress (Game.startHosting): no second one meanwhile. */
    this.hostingPending = false;
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
   * Load textures, build every subsystem and start the loop. Independent work runs in parallel:
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
    this.visibility = new ChunkVisibility(this.meshManager); // cave culling
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
    this.entities.entityTextures = this.entityTextures; // the arrow sheet (textures/entity/arrow.png) for the arrow material
    /** Chests: their contents live in the chunk edit data; the host owns them on a server. */
    this.chests = new ChestManager(this);
    // Flowing water: scheduled updates driven from block changes; plants it floods drop their items.
    this.waterSim = new WaterSimulation(this.world, (x, y, z, id) => this._onWaterDestroys(x, y, z, id));
    this.physics.waterSim = this.waterSim;
    this.entities.waterSim = this.waterSim;
    // Lava: the same scheduler at a slower tick; lava meeting water sizzles into cobblestone.
    this.lavaSim = new WaterSimulation(this.world, (x, y, z, id) => this._onWaterDestroys(x, y, z, id), LIQUID_KINDS.lava);
    this.waterSim.onConvert = this.lavaSim.onConvert = (x, y, z) => this._sizzle(x + 0.5, y + 0.5, z + 0.5);
    this.entities.lavaSim = this.lavaSim; // primed explosives drift with lava currents too
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
    // Every player, for the mobs: natural respawns keep away from all of them, zombies pick their Survival targets among them
    // (the local player and, when hosting, the guests with their game mode and death state).
    this.entities.mobs.playerPositions = () => {
      const p = this.player, out = [{ id: 'self', x: p.position.x, y: p.position.y, z: p.position.z, dirX: -Math.sin(p.yaw), dirZ: -Math.cos(p.yaw), mode: p.gameMode, dead: p.dead }];
      if (this.remotePlayers) for (const rp of this.remotePlayers.players.values()) {
        const o = rp.state && rp.state.renderPosition ? rp.state.renderPosition : null;
        if (o) out.push({ id: rp.id, x: o.x, y: o.y, z: o.z, dirX: -Math.sin(rp.state.yaw || 0), dirZ: -Math.cos(rp.state.yaw || 0), mode: rp.mode || 'survival', dead: !!(rp.state && rp.state.dead) });
      }
      return out;
    };
    this.entities.playerPositions = this.entities.mobs.playerPositions; // dropped items are simulated near any player too
    // Boats (Nov 15 2026): placed on water or land, two seats, the driver's own machine moves its boat.
    this.entities.boats = new BoatManager(scene, this.world, this.entityTextures, this.player);
    this.entities.boats.playerPositions = this.entities.mobs.playerPositions;
    this.entities.boats.onLocalSeat = (boat, seat) => this._onLocalSeat(boat, seat);
    this._seat = new THREE.Vector3();
    this._rideTeleports = 0;
    // A zombie's hit: the local player takes it through the health system (armor applies); a guest gets it from the host.
    this.entities.mobs.hurtPlayer = (targetId, base, kx, kz) => {
      if (targetId === 'self') { if (this.health.active && !this.player.dead) this.health.damage(zombieDamage(this.inventory.armorValue(), base), { kind: 'zombie' }, { kx, kz }); return; }
      if (this.net && this.net.isHost) this.net.zombieHit(targetId, base, kx, kz);
    };
    // Arrows and explosions: the voxel ray helper for sweeps / exposure, the other players, the effects and the player damage.
    this.entities.raycaster = this.raycaster;
    this.entities.effects = {
      arrowHitBlock: (x, y, z) => this.audio.playAt('items/arrow_hit_block', x, y, z, 'blocks', 0.7),
      arrowHitEntity: (x, y, z) => this.audio.playAt('items/arrow_hit_entity', x, y, z, 'blocks', 0.8),
      debris: (x, y, z, blocks) => { const n = Math.min(blocks.length, 24); for (let i = 0; i < n; i++) { const b = blocks[Math.floor(i * blocks.length / n)]; this.particles.spawnBlockBreak(b[0], b[1], b[2], BlockIds.DIRT, 3); } },
      explosion: (x, y, z, power) => this._explosionEffects(x, y, z, power),
    };
    this.entities.hurtPlayer = (shooter, hit) => this._projectileHurt(shooter, hit);
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
      explosivesAllowed: () => !this.worldMeta || this.worldMeta.explosives !== false,
      pvpAllowed: () => !this.worldMeta || this.worldMeta.pvp !== false,
    });
    this.entities.explosivesAllowed = () => !this.worldMeta || this.worldMeta.explosives !== false; // arrows set explosives off only while they are on
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
    this.entities.remotePlayers = this.remotePlayers;
    this.ui.init();
    this._wireEvents();
    this.perf = new PerformanceMonitor(this);
    this._applyPerformanceSettings();
    // Voxel lighting: everything coloured on the CPU reads the sky light at its position.
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

  /** Push the Performance options into the loop, entities, water and particles. */
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
    if (this.entities.boats) { this.entities.boats.simDistanceBlocks = simBlocks; this.entities.boats.entityDistanceBlocks = entityBlocks; }
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
      if (key === 'renderDistance') { this.sky.setRenderDistance(value); this.renderer.setRenderDistance(value); this.chunkManager.invalidate(); this.entities.mobs.setRenderDistance(value); this._applyPerformanceSettings(); }
      else if (key === 'antialias') this._applyAntialias();
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
    // Multiplayer: the host validates its own hits like any guest's; deaths are announced.
    ev.on('player:hitPlayer', (targetId, crit, extra) => { if (this.net && this.net.isHost) this.net.hitPlayer(targetId, crit, extra); });
    // A mace smash (predicted at the click): the thud, the whoosh, the wind ring at the target and a short camera shake; the host's own
    // velocities are the real ones, so its smashes go straight to the guests (a guest's are confirmed by the host first).
    ev.on('player:smash', (x, y, z) => { this.smashEffects(x, y, z); this.cameraController.shake(0.5); if (this.net && this.net.isHost) this.net.broadcastSmash(x, y, z); });
    ev.on('player:died', (cause) => { if (this.net && this.net.isHost) this.net.announceOwnDeath(cause); });
    // Eating: chewing sounds + crumbs of the food's icon from the mouth; healing when done.
    ev.on('player:eating', (itemId) => {
      this.audio.playPlayer('eat', 0.7);
      const item = ItemRegistry.get(itemId);
      const eye = this.player.getEyePosition(this._eye); const dir = this.player.getLookDirection(this._dir);
      if (item) this.particles.spawnItemCrumbs(eye.x + dir.x * 0.5, eye.y - 0.25 + dir.y * 0.5, eye.z + dir.z * 0.5, getTileIndex(item.texture), 4);
    });
    ev.on('player:ate', (itemId, heal) => { this.health.heal(heal); this.audio.playPlayer('eat_done', 0.8); });
    ev.on('player:jump', () => this.audio.playStep(this._blockUnderPlayer(), 0.18));
    // The bow: the draw creak, then the shot (an arrow leaves the inventory in Survival; a guest asks the host to shoot it).
    ev.on('player:drawStart', () => this.audio.playPlayer('bow_draw', 0.8));
    // Gliding: a crash into a wall hurts ((lost speed × 10 − 3) × 5 before armor); a rocket boosts the glide.
    ev.on('player:crash', (dmg) => { if (this.health.active && !this.player.dead) this.health.damage(Math.round(dmg * armorReduction(this.inventory.armorValue())), { kind: 'crash' }, { ignoreInvuln: true }); });
    ev.on('player:rocket', () => this._useRocket());
    ev.on('player:dash', () => this._dash());
    ev.on('player:toast', (text) => this.ui.hud.showToast(text, false));
    ev.on('player:shoot', (power) => this._shoot(power));
    // Explosives: placing one primes an entity at once (the host does it for a guest).
    ev.on('explosive:place', (x, y, z) => {
      if (this.net && !this.net.isHost) { this.net.prime(x, y, z); return; }
      if (this.worldMeta && this.worldMeta.explosives === false) return;
      this.entities.primeExplosive(x, y, z);
    });
    ev.on('player:splash', () => this.audio.playPlayer('splash', 0.8));
    ev.on('item:pickup', () => this.audio.playUI('pop', 0.9));
    // Boats: placing from the hand, getting in with use, hitting one (the host does each for a guest).
    ev.on('boat:place', (x, y, z, yaw) => this.placeBoat(x, y, z, yaw));
    ev.on('boat:enter', (boat) => this.enterBoat(boat));
    ev.on('boat:hit', (boat) => this.hitBoat(boat));
    ev.on('block:changed', (x, y, z) => { if (this.isGuest) return; this.waterSim.onBlockChanged(x, y, z); this.lavaSim.onBlockChanged(x, y, z); }); // guests only mirror the host's flow
    ev.on('chunk:loaded', (cx, cz) => {
      if (this.net && !this.net.isHost) return; // guests: the host owns water flow and mobs
      this.waterSim.onChunkLoaded(cx, cz);
      this.lavaSim.onChunkLoaded(cx, cz); // lava flow parked at an unloaded chunk border resumes too
      this.entities.mobs.onChunkLoaded(cx, cz);
      // First generation of this chunk in this world: roll the deterministic mob group. While natural spawning is off the chunk
      // stays out of spawnedChunks, so turning the setting on later fills it the next time it loads.
      const key = chunkKeyString(cx, cz);
      if (this.entities.mobs.naturalEnabled && !this.session.spawnedChunks.has(key)) {
        this.session.spawnedChunks.add(key);
        const chunk = this.world.getChunk(cx, cz);
        if (chunk) this.entities.mobs.spawnForChunk(this.world.seed, chunk);
      }
    });
    ev.on('chunk:unloading', (cx, cz) => this.entities.mobs.onChunkUnloading(cx, cz));
    ev.on('station:open', (station, pos) => this.openInventory(station, pos));
    ev.on('block:changed', (x, y, z, info) => this.chests.onBlockChanged(x, y, z, info.old, info.id)); // a broken chest drops its contents
    ev.on('craft:done', (recipe) => this.audio.playUI(recipe.stations.includes('furnace') ? 'smelt' : 'craft', 0.8));
    ev.on('item:thrown', () => this.audio.playUI('drop', 0.7));
    this.canvas.addEventListener('mousedown', () => {
      if (this.state.is(State.PLAYING) && !this.lock.locked && !this.ui.chat.isOpen) this.requestPointerLock('canvas');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.session.save(false); this._hiddenSince = performance.now(); }
      else this.loop.resetTiming();
      // A hosting tab keeps simulating in the background on a worker ticker (page timers are throttled there).
      this._updateHiddenTicker();
    });
    // Async cloud saves cannot finish while the page closes: warn when edits are still unsaved.
    window.addEventListener('beforeunload', (e) => { if (this.session.hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; } });
    // A session that expires or is revoked sends the player back to the account screen.
    ev.on('account:signedout', () => { this._dropNet(); if (this.state.inWorld) this.session.abandon(); if (!this.state.is(State.ACCOUNT)) this.state.set(State.ACCOUNT); });
  }

  // ---- LAN multiplayer ----

  /** True while this tab is a guest on someone else's server. */
  get isGuest() { return !!(this.net && !this.net.isHost); }

  /**
   * Every material a frame can use (the chunk passes plain and lit, the shadow depth materials, lava, the block / item
   * model materials, characters, particles, the sky, overlays), for Renderer.precompile() during loading.
   */
  precompileMaterials() {
    const out = [];
    const add = (m) => { if (m && m.isMaterial && !out.includes(m)) out.push(m); };
    const walk = (root) => { if (root) root.traverse((o) => { if (o.material) { if (Array.isArray(o.material)) o.material.forEach(add); else add(o.material); } }); };
    if (this.meshManager) { for (const m of Object.values(this.meshManager.baseMaterials || {})) add(m); }
    if (this.shaders && this.shaders.allMaterials) this.shaders.allMaterials().forEach(add);
    add(this.blockModelMaterial); add(this.handBlockMaterial);
    if (this.entities) { add(this.entities.material); add(this.entities.materialTranslucent); }
    if (this.particles) add(this.particles.material);
    if (this.sky) { add(this.sky.dome && this.sky.dome.material); add(this.sky.sun && this.sky.sun.material); add(this.sky.sunGlow && this.sky.sunGlow.material); }
    if (this.selectionBox) add(this.selectionBox.lines && this.selectionBox.lines.material);
    if (this.playerModel) walk(this.playerModel.root);
    return out;
  }

  /** The anti-aliasing setting changed: FXAA / Off apply live; an MSAA change needs the WebGL context recreated, i.e. a reload. */
  _applyAntialias() {
    const r = this.renderer;
    r.setAntialias(this.settings.get('antialias'));
    if (r.aaNeedsReload) this.ui.hud.showToast('Reload the page to apply the MSAA setting', false);
    else if (r.msaaUnsupported && msaaSamplesOf(this.settings.get('antialias')) > 0) this.ui.hud.showToast('MSAA is not available here; FXAA is used instead', false);
  }

  /** Load one of my worlds and host it (Multiplayer → Host New Server); it wins over the world's Same Wi-Fi setting. `opts`: { maxPlayers, visibility } or just the player limit. */
  async hostWorld(worldId, opts = MAX_PLAYERS_DEFAULT) {
    const ok = await this.startWorld(worldId, { lan: false });
    if (!ok) return false;
    return this.startHosting(opts);
  }

  /**
   * Publish the lobby for the world being played; the host plays on as a normal player. `opts`: { maxPlayers, visibility } or
   * the player limit — or `{ lan: true }` for the world's Same Wi-Fi multiplayer setting: a Private lobby for up to 8 players
   * with no relay credentials fetched and offers polled every 2 s, announced with one short line instead of the hosting toast.
   */
  async startHosting(opts = MAX_PLAYERS_DEFAULT) {
    if (this.net || this.hostingPending || !this.state.inWorld || this.session.remote) return false;
    const options = typeof opts === 'number' ? { maxPlayers: opts } : { ...(opts || {}) };
    if (options.lan) Object.assign(options, { visibility: 'private', maxPlayers: MAX_PLAYERS_MAX, turn: false, offerPollMs: 2000 });
    const host = new HostServer(this, options);
    this.hostingPending = true;
    try { await host.start(); } catch (e) {
      console.warn('Game: hosting failed', e);
      this.ui.hud.showToast(options.lan ? "Couldn't open the world to your Wi-Fi. Check your connection." : "Couldn't publish the server. Check your connection.", false);
      return false;
    } finally { this.hostingPending = false; }
    if (!this.state.inWorld) { host.stop('closed'); return false; } // the world was left while the lobby was being published
    this.net = host;
    if (host.lanMode) this.ui.hud.showToast(host.networkDetected ? `Open to your Wi-Fi · code ${host.joinCode}` : `Couldn't detect your Wi-Fi. Players can still join with code ${host.joinCode}.`, false);
    else {
      this.ui.hud.showToast(`Hosting (${host.visibility}) · code ${host.joinCode} · keep this tab visible while hosting`, false);
      this.systemChat(`Hosting a ${host.visibility} server · join code ${host.joinCode}`, 'gray', false);
    }
    this.ui.pause.refresh();
    this._netChanged();
    return true;
  }

  /**
   * Back to single player in the same world; guests see "The host closed the server". `reopenLan` (the pause menu's Stop
   * Hosting): a world whose Same Wi-Fi multiplayer setting is on opens to the network again, since that setting is its switch.
   */
  stopHosting(reopenLan = false) {
    if (!this.net || !this.net.isHost) return;
    this.net.stop('stopped');
    this.net = null;
    this.ui.pause.refresh();
    this._netChanged();
    if (reopenLan && this.state.inWorld && worldSetting(this.worldMeta, 'lanOpen')) this.startHosting({ lan: true }).then(() => this.ui.pause.refresh());
  }

  /** The worker ticker that keeps a hidden hosting tab simulating: only while a guest is connected to a world open through its Same Wi-Fi setting. */
  _updateHiddenTicker() {
    const host = this.net && this.net.isHost ? this.net : null;
    this.loop.setHiddenTicker(document.hidden && !!host && (!host.lanMode || host.peers.size > 0));
  }

  /** Push the world's mob-related settings (hostile mobs, natural spawning, fall damage) to the mob manager; guests only mirror the host's mobs. */
  applyWorldSettings() {
    const mobs = this.entities && this.entities.mobs;
    if (!mobs || this.isGuest) return;
    const m = this.worldMeta;
    mobs.setHostileEnabled(worldSetting(m, 'hostileMobs') !== false);
    mobs.setNaturalEnabled(worldSetting(m, 'naturalMobs') !== false);
    mobs.fallDamageEnabled = worldSetting(m, 'fallDamage') !== false;
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
      this.ui.fade(() => this.ui.multiplayer.showFind(e.message || 'Could not connect.')); // queued behind the state's own switch: both run at black
      return false;
    }
    this.net = client;
    client.onHostClosed = (reason) => this._connectionLost(reason);
    const ok = await this.session.startRemote(client, welcome);
    if (!ok) { this._dropNet(); return false; }
    // The host decides the guest's game mode and whether it may change it.
    const you = welcome.you || {};
    client.canChangeMode = !!you.canChangeMode;
    if (this.worldMeta) { this.worldMeta.keepInventory = !!welcome.keepInventory; this.worldMeta.pvp = welcome.pvp !== false; }
    const mode = you.mode || welcome.gameMode;
    if (mode && this.player.gameMode !== mode) this.setGameMode(mode, true);
    this._netChanged();
    return true;
  }

  /** Leave the server (pause menu "Leave Server", a lost host, a kick): back to the multiplayer server list, the reason on it. */
  leaveServer(message = null) {
    const client = this.net;
    if (!client || client.isHost) return;
    this.net = null;
    client.close(true);
    if (this.state.inWorld || this.state.is(State.LOADING)) this.session.abandon();
    if (!this.state.is(State.KICKED)) { this.state.set(State.MENU); this.ui.fade(() => this.ui.multiplayer.showMain(message)); }
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
    if (this.net.isHost) this.net.stop('closed');
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
    this.presence.stop(); // the other place is the one that is online now
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
    this.presence.start();
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
    this.player.holdingGlider = ItemRegistry.isGlider(id); // gliding needs the glider in the hand (bloxd style)
  }

  /** A rocket while gliding: one from the inventory (none in Creative), 0.2 s of game time apart; a guest asks the host first. */
  _useRocket() {
    const p = this.player;
    if (!p.gliding || p.rocketCooldown > 0 || p.dead) return;
    if (!p.isCreative && this._findItemSlot(ItemIds.ROCKET) < 0) return;
    if (this.net && !this.net.isHost) { this.net.rocket(); return; } // the host validates and answers ROCKET_OK
    this._fireRocket();
  }

  /**
   * A rocket used directly (right click with a rocket in the hand, not gliding): a dash of about 5 blocks along the look, pitch
   * included (ROCKET_DASH_SPEED for ROCKET_DASH_SECONDS, gravity off, see PlayerPhysics), one rocket in Survival, a 0.75 s cooldown.
   * Applied locally at once (a guest tells the host, which checks its inventory and the cooldown for the sound — never undone);
   * not while dead, a spectator, flying, gliding, or in water / lava (then nothing happens and no rocket is used).
   */
  _dash() {
    const p = this.player;
    if (p.dead || p.isSpectator || p.flying || p.gliding || p.inWater || p.inLava || p.dashCooldown > 0 || p.dashTime > 0) return;
    if (!p.isCreative) { const slot = this._findItemSlot(ItemIds.ROCKET); if (slot < 0) return; this.inventory.removeFromSlot(slot, 1); }
    p.getLookDirection(p.dashDir);
    p.velocity.copy(p.dashDir).multiplyScalar(ROCKET_DASH_SPEED); // from this very frame on; the physics keeps it for the dash's duration
    p.onGround = false;
    p.dashTime = ROCKET_DASH_SECONDS;
    p.dashCooldown = ROCKET_DASH_COOLDOWN;
    p.dashGrace = 0;
    p.dashFallBefore = p.fallStartY !== null ? Math.max(0, p.fallStartY - p.position.y) : 0; // a landing during / right after the dash counts only this
    p.fallStartY = null;
    this.cameraController.rocket();
    this.audio.playAt('items/rocket_launch', p.position.x, p.position.y + 1, p.position.z, 'player', 0.9);
    this.events.emit('player:rocketFired'); // when hosting, the launch sound goes to the guests
    if (this.net && !this.net.isHost) this.net.rocketDash();
  }

  /** The boost itself (after the host's OK for a guest). */
  _fireRocket() {
    const p = this.player;
    if (!p.gliding || p.dead) return;
    if (!p.isCreative) { const slot = this._findItemSlot(ItemIds.ROCKET); if (slot < 0) return; this.inventory.removeFromSlot(slot, 1); }
    p.rocketTime = ROCKET_SECONDS; // the camera's rocket rush (the huge FOV) follows rocketTime; the HUD vignette follows the camera
    p.rocketCooldown = ROCKET_COOLDOWN;
    this.audio.playAt('items/rocket_launch', p.position.x, p.position.y + 1, p.position.z, 'player', 0.9);
    this.events.emit('player:rocketFired');
  }

  /** The smoke-and-spark trail behind a boosting player at (x, y, z) moving along (vx, vy, vz). */
  rocketTrail(x, y, z, vx, vy, vz) {
    const len = Math.hypot(vx, vy, vz) || 1;
    const bx = x - vx / len * 0.7, by = y - vy / len * 0.7, bz = z - vz / len * 0.7;
    this.particles.spawnSmoke(bx, by, bz, 2, 0.9);
    this.particles.spawnFlame(bx, by, bz, 2, 0.25, -0.5);
  }

  /** Shoot an arrow from the eyes along the view (power 0..1 from the draw); Survival uses one arrow up. */
  _shoot(power) {
    const p = this.player;
    if (p.dead || p.isSpectator) return;
    const creative = p.isCreative;
    if (!creative) { const slot = this._findItemSlot(ItemIds.ARROW); if (slot < 0) return; this.inventory.removeFromSlot(slot, 1); }
    const eye = p.getEyePosition(this._eye), dir = p.getLookDirection(this._dir);
    this.audio.playPlayer('bow_shoot', 0.9);
    this.hand.bowKick(); // no swing: the bow just recoils back to its resting frame; third person / remote players only lower their arms
    if (this.net && !this.net.isHost) { this.net.shoot(eye, dir, power); return; }
    const origin = { x: eye.x + dir.x * 0.3, y: eye.y - 0.1 + dir.y * 0.3, z: eye.z + dir.z * 0.3 };
    this.entities.shootArrow(origin, dir, power, 'self', { pickup: !creative });
  }

  /**
   * An arrow or an explosion reached a player (EntityManager.hurtPlayer): the local player takes it through the health
   * system (armor applies, like every player hit); a guest gets it from the host (which knows their armor).
   */
  _projectileHurt(shooter, hit) {
    if (hit.id === 'self') {
      if (!this.health.active || this.player.dead || this.player.isCreative || this.player.isSpectator) return;
      const armor = this.inventory.armorValue(); // { points, cap }: Encorsed pieces lift the cap
      if (hit.kind === 'arrow') {
        if (shooter !== 'self' && this.worldMeta && this.worldMeta.pvp === false) return;
        const rp = shooter === 'self' ? null : this.remotePlayers.get(shooter);
        const by = rp ? rp.name : 'another player';
        this.health.damage(arrowPlayerDamage(hit.power, hit.bonus, armor), { kind: 'arrow', by }, { kx: hit.kx, kz: hit.kz, crit: hit.crit, ignoreInvuln: true });
      } else {
        const n = explosionPlayerDamage(hit.impact, hit.power, this.inventory.explosionArmorValue()); // obsidian / Encorsed count 1.5× here, with the explosion cap
        this.health.damage(n, { kind: 'explosion' }, { ignoreInvuln: true });
        const k = EXPLOSION_KNOCKBACK * hit.impact, v = this.player.velocity;
        v.x += hit.kx * k; v.z += hit.kz * k; v.y += hit.ky * k;
        this.cameraController.shake(hit.impact);
      }
      return;
    }
    if (this.net && this.net.isHost) this.net.projectileHit(shooter, hit);
  }

  /** A mace smash at (x, y, z) (ours, or another player's SMASH): the heavy thud, the wind whoosh and a ring of white dust at the target's feet. */
  smashEffects(x, y, z) {
    this.audio.playAt('player.mace_smash', x, y, z, 'blocks', 1.0);
    this.audio.playAt('player.wind_burst', x, y, z, 'blocks', 0.9);
    this.particles.spawnWindRing(x, y, z, 28);
  }

  /** The flash, the smoke cloud, the boom (louder close by) and the camera shake of an explosion at (x, y, z). */
  _explosionEffects(x, y, z, power) {
    this.particles.spawnSmoke(x, y + 0.5, z, 24, 2.2);
    this.particles.spawnPuff(x, y + 0.5, z, 20, BlockIds.SAND);
    this.audio.playAt('explosives/explosion', x, y, z, 'blocks', 1.0);
    const p = this.player.position, d = Math.hypot(p.x - x, p.y + 1 - y, p.z - z);
    if (d < 24) { this.cameraController.shake((1 - d / 24) * 0.8); this.ui.hud.flash(Math.max(0.15, 1 - d / 16)); }
  }

  /** Index of the first inventory slot (hotbar first) holding `itemId`, or −1. */
  _findItemSlot(itemId) {
    const inv = this.inventory;
    for (let i = 0; i < INVENTORY_SIZE; i++) { const s = inv.get(i); if (s && s.itemId === itemId) return i; }
    return -1;
  }

  /** Water flowed into a plant: drop its item and show particles. */
  /** Lava met water, or an item burned: a hiss and a little smoke. */
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

  /**
   * Load a world (the world list's Play, ?world=, ?autoplay). A world whose Same Wi-Fi multiplayer setting is on opens to the
   * network as soon as it plays; Multiplayer → Host passes `lan: false` and hosts on its own terms afterwards.
   */
  async startWorld(worldId, { lan = true } = {}) {
    const ok = await this.session.start(worldId);
    if (ok && lan && !this.net && this.state.inWorld && worldSetting(this.worldMeta, 'lanOpen')) await this.startHosting({ lan: true });
    return ok;
  }

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
   * the next key press or click instead; a click (the Resume button) or a key such as E locks at once.
   * In single player the world was paused, so the loop's timing restarts without catching up.
   */
  resume(lock = true) {
    if (this.state.is(State.PAUSED)) {
      this.state.set(State.PLAYING);
      this.loop.resetTiming();
      if (lock) this.requestPointerLock('resume'); else this.lock.relockOnNextInput();
    } else if (this.state.is(State.INVENTORY)) this.closeInventory(lock);
  }

  /**
   * @param {'inventory'|'crafting_table'|'furnace'|'chest'} station recipe list (or the chest) to show
   * @param {{x: number, y: number, z: number}|null} pos the station block (chests)
   */
  openInventory(station = 'inventory', pos = null) {
    if (!this.state.is(State.PLAYING)) return;
    if (this.player.isSpectator && station !== 'inventory') return; // spectators cannot use stations (or chests)
    if (this.ui.chat.isOpen) this.ui.chat.close(false);
    this.lock.release('inventory');
    this.state.set(State.INVENTORY);
    if (station === 'chest' && pos) {
      const chest = this.chests.open(pos.x, pos.y, pos.z);
      if (this.isGuest) this.net.chestOpen(pos.x, pos.y, pos.z); // the host's contents arrive as CHEST_CONTENTS
      this.ui.inventory.open('chest', chest, { x: pos.x, y: pos.y, z: pos.z });
      this.audio.playAt('blocks/chest_open', pos.x + 0.5, pos.y + 0.5, pos.z + 0.5, 'blocks', 0.8);
      return;
    }
    this.ui.inventory.open(station);
    this.audio.playUI('inv_open');
  }

  closeInventory(lock = true) {
    if (!this.state.is(State.INVENTORY)) return;
    const chestPos = this.ui.inventory.station === 'chest' ? this.ui.inventory.chestPos : null;
    this.ui.inventory.close();
    this.state.set(State.PLAYING);
    if (chestPos) this.audio.playAt('blocks/chest_close', chestPos.x + 0.5, chestPos.y + 0.5, chestPos.z + 0.5, 'blocks', 0.8);
    else this.audio.playUI('inv_close');
    if (lock) this.requestPointerLock('inventory-close'); else this.lock.relockOnNextInput();
  }

  // ---- Chat and commands ----

  /** Chat box: `prefill` '/' when the slash key opened it. */
  /** /locate: the nearest structure or biome from the player, searched in a chunk worker. */
  locate(kind, name) {
    const p = this.player.position;
    return this.chunkManager.locate(kind, name, Math.floor(p.x), Math.floor(p.z), LOCATE_MAX_DISTANCE);
  }

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

  // ---- /tick: game speed on Minecraft's 20-ticks-per-second scale ----

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

  /**
   * The pause menu is only an overlay in multiplayer (the host's simulation never stops, guests keep mirroring) — except in a
   * world open through its Same Wi-Fi setting with nobody joined, which pauses like single player. Also called by the host
   * server when a guest joins or leaves.
   */
  _netChanged() {
    const n = this.net;
    this.state.overlayPause = !!n && (!n.isHost || !n.lanMode || n.peers.size > 0);
    this._updateHiddenTicker();
    this.events.emit('net:changed');
  }

  /** Survival → Creative → Spectator → Survival (the pause menu's button and the toggleGameMode key): asks before the badge is lost, refused in a locked world. */
  cycleGameMode() {
    const i = GAME_MODE_ORDER.indexOf(this.player.gameMode);
    return this.requestGameMode(GAME_MODE_ORDER[(i + 1) % GAME_MODE_ORDER.length]);
  }

  /** @deprecated use cycleGameMode */
  toggleGameMode() { return this.cycleGameMode(); }

  // ---- the game mode lock and the Pure Survival badge (part 3 of 4, Nov 11 2026) ----

  /** The mode this world is locked to (chosen at creation, never changes), or null. */
  get lockedMode() { return lockedModeOf(this.worldMeta); }

  /** Does this world still have its Pure Survival badge? */
  get survivalOnly() { return !!(this.worldMeta && this.worldMeta.survivalOnly === true); }

  /** Would a cheat take the badge away here (only the owner / host writes the badge off; a guest never owns it)? */
  get badgeAtStake() { return this.survivalOnly && !this.isGuest; }

  /** Why no cheat may run right now — a world locked to Survival, a guest without the host's permission — or null. */
  cheatDenied() {
    if (this.lockedMode === 'survival') return lockedText('survival');
    if (this.isGuest && !this.net.canChangeMode) return NO_CHEATS_TEXT;
    return null;
  }

  /**
   * A player-initiated mode change (the pause button, the key, the mode selects, /set gamemode): refused in a locked world
   * and for a guest without permission; leaving Survival first asks to give up the badge (`confirm`; the command flow asked
   * already) and writes it off — a failed write refuses the change. Returns true / false, or a promise of it when it had to ask or write.
   */
  requestGameMode(mode, { confirm = true } = {}) {
    const locked = this.lockedMode;
    if (locked) { this.ui.hud.showMessage(lockedText(locked)); return false; }
    if (this.isGuest && !this.net.canChangeMode) { this.ui.hud.showMessage('The host controls your game mode.'); return false; }
    if (mode === this.player.gameMode) return true;
    if (mode !== 'survival' && this.badgeAtStake) return this.loseBadge({ confirm }).then((ok) => ok && this.setGameMode(mode));
    return this.setGameMode(mode);
  }

  /**
   * Give up the world's Pure Survival badge: ask first (`confirm`, the in-game confirm box with "Remove the badge" / "Cancel"),
   * write `survival_only: false` to the world row at once, and only then forget it here (guests follow through WORLD).
   * Resolves false when cancelled or when the write failed (OFFLINE_TEXT, shown unless `silent`): the action must not happen.
   */
  async loseBadge({ confirm = true, silent = false } = {}) {
    const meta = this.worldMeta;
    if (!meta || meta.survivalOnly !== true) return true;
    if (confirm && !(await this.ui.confirm.ask(BADGE_SENTENCE, { ok: 'Remove the badge', cancel: 'Cancel' }))) return false;
    if (meta.survivalOnly !== true || this.worldMeta !== meta) return true; // lost or left meanwhile
    if (!this.isGuest && meta.id) {
      try { await this.saveManager.removeSurvivalBadge(meta.id); }
      catch (e) { console.warn('Game: could not write the badge off', e); if (!silent) this.ui.hud.showMessage(OFFLINE_TEXT); return false; }
    }
    meta.survivalOnly = false;
    this.session.changedSinceSave = true;
    if (this.net && this.net.isHost) this.net.broadcastWorldSettings();
    this.events.emit('badge:changed', false);
    if (this.ui.pause) this.ui.pause.refresh();
    return true;
  }

  /**
   * The raw mode setter. `forced` is the host's decision (the WELCOME or a MODE message); a guest cannot change its own mode
   * without permission. A locked world never leaves its mode (not even forced); leaving Survival through this direct call
   * (a debug / test hook — the UI and the commands go through requestGameMode, which asks first) still writes the badge off.
   */
  setGameMode(mode, forced = false) {
    const locked = this.lockedMode;
    if (locked && mode !== locked) { if (!forced) this.ui.hud.showMessage(lockedText(locked)); return false; }
    if (!forced && this.isGuest && !this.net.canChangeMode) { this.ui.hud.showMessage('The host controls your game mode.'); return false; }
    const p = this.player;
    const wasSpectator = p.isSpectator;
    p.gameMode = mode;
    if (p.isSpectator && p.riding) this.leaveBoat();
    if (p.isSpectator) { p.flying = true; p.velocity.set(0, 0, 0); }
    else if (!p.isCreative) p.flying = false;
    if (wasSpectator && !p.isSpectator) this._unbury();
    if (this.worldMeta) this.worldMeta.gameMode = mode;
    this.session.gameModeChanged(mode);
    this.ui.hud.showMessage(`Game Mode: ${modeName(mode)}`);
    this.events.emit('gamemode:changed', mode);
    if (mode !== 'survival' && this.badgeAtStake) this.loseBadge({ confirm: false, silent: true }); // never a badge on a world that left Survival
    return true;
  }

  // ---- boats (Nov 15 2026): placing, seats, getting in and out, breaking ----

  /** A boat from the hand at (x, y, z) facing `yaw` (BlockInteraction checked the space and used the item); a guest asks the host. */
  placeBoat(x, y, z, yaw) {
    if (this.net && !this.net.isHost) { this.net.boatPlace(x, y, z, yaw); return; }
    this.entities.boats.spawn(x, y, z, yaw);
    this.audio.playBlock('place', BlockIds.PLANKS, x, y + 0.3, z);
  }

  /** Use on a boat: the front seat when it is free (and drive), else the back seat; a full boat does nothing. A guest asks the host, which answers with the seats. */
  enterBoat(boat) {
    const p = this.player;
    if (!boat || boat.dead || p.riding === boat || p.dead || p.isSpectator) return;
    if (boat.driver !== null && boat.passenger !== null) return;
    if (this.net && !this.net.isHost) { this.net.boatEnter(boat.id); return; }
    this.entities.boats.assign(boat, this.entities.boats.localId);
  }

  /** Out of the boat: onto the nearest free spot beside it (`forced`: wherever the body already is — a death, a teleport, the boat gone). */
  leaveBoat(forced = false) {
    const p = this.player, boats = this.entities.boats, boat = p.riding;
    if (!boat) return;
    boats.clearRider(boats.localId);
    if (!forced && !boat.dead) { boats.exitSpot(boat, this._seat); p.teleport(this._seat.x, this._seat.y, this._seat.z); this._unbury(); }
    p.velocity.set(0, 0, 0); p.fallStartY = null; p.onGround = false;
    if (this.net && !this.net.isHost) this.net.boatLeave();
  }

  /** Hit a boat: an empty one breaks and drops the item (not in Creative); one with a rider only takes the swing. A guest asks the host. */
  hitBoat(boat) {
    if (!boat || boat.dead) return;
    this.events.emit('player:swing');
    const bp = boat.position;
    if (boat.driver !== null || boat.passenger !== null) { this.audio.playBlock('hit', BlockIds.PLANKS, bp.x, bp.y + 0.3, bp.z); return; }
    if (this.net && !this.net.isHost) { this.net.boatBreak(boat.id); return; }
    this.breakBoat(boat, !this.player.isCreative);
  }

  breakBoat(boat, drop) {
    const bp = boat.position.clone();
    this.entities.boats.remove(boat);
    if (drop) this.entities.spawnItem(bp.x, bp.y + 0.3, bp.z, ItemIds.BOAT, 1, 0, 1.5, 0, ITEM_PICKUP_DELAY);
    this.audio.playBlock('break', BlockIds.PLANKS, bp.x, bp.y + 0.3, bp.z);
    this.particles.spawnBlockBreak(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z), BlockIds.PLANKS, 10);
  }

  /** The local player sat down (seat 0 / 1) or got up (-1): the body is put on the seat at once, no pose of its own. */
  _onLocalSeat(boat, seat) {
    const p = this.player;
    if (boat && seat >= 0) {
      p.sneaking = false; p.swimming = false; p.crawling = false; p.sprinting = false; p.gliding = false; p.rocketTime = 0; p.dashTime = 0; p.flying = false; p.fallStartY = null;
      boat.seatPosition(seat, this._seat);
      p.position.copy(this._seat); p.prevPosition.copy(this._seat); p.renderPosition.copy(this._seat);
      p.velocity.copy(boat.velocity);
      this._rideTeleports = p.teleports || 0;
      this.interaction.placeTimer = 0;
    }
  }

  /** Before the entities step: a teleport since the last step (a /tp, a respawn, a correction) ends the ride; the driver's keys steer. */
  _rideInput() {
    const p = this.player, boat = p.riding;
    if ((p.teleports || 0) !== this._rideTeleports || boat.dead) { this.leaveBoat(true); return; }
    if (p.seat === 0 && !boat.remote) { boat.input.forward = p.intent.forward; boat.input.turn = -p.intent.strafe; }
  }

  /** After the entities step: the body sits on its seat with the boat's velocity, no pose of its own; water and lava still count. */
  _rideFollow() {
    const p = this.player, boat = p.riding;
    if (!boat || boat.dead) { if (boat) this.leaveBoat(true); return; }
    boat.seatPosition(p.seat, this._seat);
    p.prevPosition.copy(p.position);
    p.position.copy(this._seat);
    p.velocity.copy(boat.velocity);
    p.onGround = boat.onGround;
    p.sneaking = false; p.swimming = false; p.crawling = false; p.sprinting = false; p.gliding = false; p.flying = false; p.fallStartY = null; p.fallIgnoreAboveY = null;
    p.horizontalSpeed = boat.speed;
    p.updateAABB();
    this.physics.liquidState(p);
    this._rideTeleports = p.teleports || 0;
  }

  // ---- what the commands act on: players, items, mobs ----

  /** This player's name (the account's username). */
  playerName() { return (this.account && this.account.username) || 'you'; }

  /** The actor of a command typed here: { id: 'self', name, x, y, z }. */
  selfActor() { const p = this.player.position; return { id: 'self', name: this.playerName(), x: p.x, y: p.y, z: p.z, remote: false }; }

  /** Every player in this world, this one first: the host sees its guests, a guest the other players it knows. */
  playerNames() {
    const names = [this.playerName()];
    if (this.net && this.net.isHost) { for (const peer of this.net.peers.values()) if (peer.name) names.push(peer.name); }
    else if (this.remotePlayers) { for (const rp of this.remotePlayers.players.values()) if (rp.name) names.push(rp.name); }
    return names;
  }

  /** A player by name (case-insensitive) with its current position, or null: { id ('self' | userId), name, x, y, z }. */
  playerByName(name) {
    const want = String(name || '').toLowerCase();
    if (want === this.playerName().toLowerCase()) return this.selfActor();
    if (this.net && this.net.isHost) {
      for (const peer of this.net.peers.values()) if (peer.name && peer.name.toLowerCase() === want && peer.state) return { id: peer.userId, name: peer.name, x: peer.state[0], y: peer.state[1], z: peer.state[2], remote: true };
    } else if (this.remotePlayers) {
      for (const [id, rp] of this.remotePlayers.players) if (rp.name && rp.name.toLowerCase() === want) return { id, name: rp.name, x: rp.position.x, y: rp.position.y, z: rp.position.z, remote: true };
    }
    return null;
  }

  /** The item names /give accepts (the creative catalog) and their display names. */
  itemNames() { return ItemRegistry.catalog().map((it) => it.name); }
  itemLabel(name) { const id = ItemRegistry.idOf(name); return id >= 0 ? ItemRegistry.displayName(id) : ''; }
  /** The mob types /summon accepts and their names. */
  mobNames() { return Object.keys(MOB_BY_TYPE); }
  mobLabel(type) { const def = MOB_BY_TYPE[type]; return def ? (def.name || type.charAt(0).toUpperCase() + type.slice(1)) : ''; }

  /**
   * Move a player (/tp, /spawn): y clamped to the world; this player teleports and is un-buried, a connected guest gets SPAWN_AT
   * with its movement baseline reset (HostServer.movePeer), so the jump is never rejected. Returns { ok, x, y, z } or { ok: false, error }.
   */
  teleportPlayer(id, dest) {
    const x = Number(dest.x), z = Number(dest.z);
    const y = Math.max(1, Math.min(WORLD_HEIGHT - 3, Number(dest.y)));
    if (![x, y, z].every(Number.isFinite)) return { ok: false, error: 'That position is not valid.' };
    if (id === 'self') { this.player.teleport(x, y, z); this._unbury(); return { ok: true, x, y, z }; }
    if (this.net && this.net.isHost && this.net.movePeer(id, x, y, z)) return { ok: true, x, y, z };
    return { ok: false, error: 'That player is not here.' };
  }

  /** /give: into this player's inventory (the rest drops at the feet) or, as the host, granted to a guest. Returns the count given, 0 for an unknown item. */
  giveItem(id, name, count) {
    const itemId = ItemRegistry.idOf(name);
    if (itemId < 0 || !(count > 0)) return 0;
    if (id === 'self') { const left = this.inventory.addItem(itemId, count); if (left > 0) this._dropAtFeet(itemId, left); return count; }
    if (this.net && this.net.isHost && this.net.grantItem(id, itemId, count)) return count;
    return 0;
  }

  _dropAtFeet(itemId, n) {
    const p = this.player.position, max = ItemRegistry.stackSize(itemId);
    while (n > 0) { const k = Math.min(max, n); this.entities.spawnItem(p.x, p.y + 0.5, p.z, itemId, k, 0, 0, 0, ITEM_PICKUP_DELAY); n -= k; }
  }

  /** /summon: `count` mobs of `type` around `at` ({ x, y, z }), past the caps; zombies need Hostile mobs on. Returns { spawned } or { error }. */
  summonMobs(type, count, at) {
    const def = MOB_BY_TYPE[type];
    if (!def) return { error: `Unknown mob '${type}'` };
    const mobs = this.entities.mobs;
    if (def.hostile && !mobs.hostileEnabled) return { error: 'Hostile mobs are turned off in this world.' };
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, d = i === 0 ? 0 : 0.5 + Math.random() * 1.5;
      if (mobs._add(def, at.x + Math.cos(a) * d, at.y, at.z + Math.sin(a) * d, (Math.random() * 4294967296) >>> 0, Math.random() * Math.PI * 2, def.health, null, true)) spawned++;
    }
    return { spawned };
  }

  /** /setspawn: the world spawn (where every player respawns, the saved guests included) moves to `pos`. */
  setWorldSpawn(pos) {
    const p = this.player;
    p.spawn.set(pos.x, pos.y, pos.z);
    const meta = this.worldMeta;
    if (meta && meta.guests) for (const g of Object.values(meta.guests)) if (g && g.player) { g.player.spawnX = pos.x; g.player.spawnY = pos.y; g.player.spawnZ = pos.z; }
    this.session.changedSinceSave = true;
    return { x: pos.x, y: pos.y, z: pos.z };
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
      if (this.isGuest) { this.leaveServer(); return; } // → the server list
      if (this.net && this.net.isHost) this.stopHosting();
      const left = await this.session.quit();
      if (left && this.state.is(State.MENU)) this.ui.fade(() => this.ui.mainMenu.showWorlds()); // back to the world selection, not the home page (at the same black as the state's switch)
    } finally { this.ui.pause.setBusy(false); }
  }

  /** Log out: leave the world (saving) first, then return to the account screen. */
  async logout() {
    if (this.isGuest) this.leaveServer();
    if (this.net && this.net.isHost) this.stopHosting();
    if (this.state.inWorld) { const left = await this.session.quit(); if (!left) return; }
    if (this.sessionGuard) this.sessionGuard.release();
    this.kicked = false;
    await this.presence.clear(); // friends see me offline at once (best effort)
    await this.account.signOut();
    this.state.set(State.ACCOUNT);
  }

  // ---- Per-frame input dispatch ----

  _handleKeys() {
    const a = this.actions;
    const st = this.state;
    if (this.input.capturing) return; // the Settings screen's Controls tab is recording a key (Esc there only cancels that)
    if (a.wasPressed('debug')) this.ui.debug.toggle();
    if (a.wasPressed('atlasDebug')) this.ui.toggleAtlasView();
    const escape = this.input.wasPressed(PAUSE_CODE);
    // Esc closes the Settings screen first, wherever it was opened from.
    if (escape && this.ui.settings.isOpen) { this.ui.settings.close(); return; }
    if (!st.inWorld) return;
    // Esc while the mouse is locked makes the browser release the lock, and that release opens the pause menu
    // (UIManager._onPointerLock). Esc on an open screen closes it without a lock request: the game
    // resumes behind the "Click to resume" overlay. Esc while playing unlocked does nothing; the menu never
    // reopens on its own.
    if (escape) {
      if (st.is(State.INVENTORY)) this.closeInventory(false);
      else if (st.is(State.PAUSED)) this.resume(false);
    }
    if (a.wasPressed('inventory')) {
      if (st.is(State.PLAYING)) this.openInventory();
      else if (st.is(State.INVENTORY)) this.closeInventory(true); // closing with the key re-locks at once
    }
    if (!st.is(State.PLAYING)) return;
    // Chat: the bindable key, Enter, or "/" with a slash already typed. While the box is open the input
    // element has focus, so no game key reaches here.
    if (!this.ui.chat.isOpen) {
      if (a.wasPressed('chat') || this.input.wasPressed(CHAT_ENTER_CODE)) { this.openChat(''); return; }
      if (this.input.wasPressed(CHAT_SLASH_CODE)) { this.openChat('/'); return; }
    }
    if (this.player.riding && a.wasPressed('sneak')) this.leaveBoat(); // the crouch key gets out of a boat (Nov 15 2026)
    if (a.wasPressed('perspective')) this.cameraController.cycle();
    if (a.wasPressed('smoothCamera')) this.ui.hud.showMessage(`Smooth Camera: ${this.controller.setSmoothCamera(!this.controller.smoothCamera) ? 'On' : 'Off'}`); // F8 (for recording): off again on every page load
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
        const n = DROP_STACK_MODIFIERS.some((c) => this.input.isDown(c)) ? stack.count : 1; // Shift + Drop throws the whole stack
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
    if (this.player.riding) this._rideInput(); // a rider is carried by its boat (below); the driver's keys steer it
    else if (!this.player.dead) this.physics.step(dt); // a dead player's body waits for Respawn
    pr.end('physics');
    pr.begin('mobs');
    this.entities.fixedUpdate(dt);
    if (this.player.riding) this._rideFollow();
    pr.end('mobs');
    // Scheduled water updates every WATER_TICK_SECONDS (only blocks touched by a change are processed); the host
    // of a LAN server runs them for everyone, guests only mirror.
    this._waterTimer += dt;
    if (this._waterTimer >= WATER_TICK_SECONDS) {
      this._waterTimer -= WATER_TICK_SECONDS;
      if (!this.isGuest) { pr.begin('water'); this.waterSim.setSimulationCenters(this._simCenters()); this.waterSim.tick(); pr.end('water'); }
    }
    this._lavaTimer += dt;
    if (this._lavaTimer >= LAVA_TICK_SECONDS) {
      this._lavaTimer -= LAVA_TICK_SECONDS;
      if (!this.isGuest) { pr.begin('lava'); this.lavaSim.setSimulationCenters(this._simCenters()); this.lavaSim.tick(); pr.end('lava'); }
    }
  }

  /** The simulation centers for the liquids: this player and, when hosting, every connected guest (its latest position). */
  _simCenters() {
    const p = this.player.position;
    const out = [{ x: p.x, z: p.z }];
    if (this.net && this.net.isHost && this.net.peers) for (const peer of this.net.peers.values()) if (peer.state) out.push({ x: peer.state[0], z: peer.state[2] }); // `peers` guarded: a test double may host without any
    return out;
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
      this.controller.updateLook(realDt); // mouse look (and the smooth camera's glide) run on real time, never /tick
      this.controller.updateIntent();
      p.interpolate(alpha);
      if (p.riding && p.riding.remote) { p.riding.sampleRemote(performance.now() / 1000); p.renderPosition.copy(p.riding.seatPosition(p.seat, this._seat, true)); } // a passenger (or the host behind a guest driver) sits where the mirrored boat is drawn this frame
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
      this.hand.drawProgress = p.drawProgress;
      this.playerModel.setAiming(p.bowFrame);
      this.hand.setLight(this.lightAt(this._eye.x, this._eye.y, this._eye.z));
      this.hand.update(dt, p, this.cameraController.bobPhase, this.cameraController.handBobFactor);
      this.health.update(dt);
      // The own third-person body: alive, or dead and still tipping over (then hidden until the respawn, like other players see it).
      const showBody = !first && !spectator && (!p.dead || this.health.deathTimer < PLAYER_DEATH_SECONDS);
      this.playerModel.root.visible = showBody;
      if (showBody) {
        this.playerModel.setLight(this.lightAt(p.renderPosition.x, p.renderPosition.y + 1, p.renderPosition.z));
        this.playerModel.update(dt, p);
        if (p.dead) this.playerModel.applyDeathPose(this.health.deathTimer / PLAYER_DEATH_SECONDS);
      }
      this.ui.hud.setHotbarVisible(!spectator && !this.state.is(State.INVENTORY));
      this.sky.setLiquid(p.headInLava ? 'lava' : p.headInWater ? 'water' : null);
      this.renderer.liquidView = !!(p.headInLava || p.headInWater); // the underwater wobble runs the post chain only now
      if (p.onFire && !p.dead && !spectator) this.particles.spawnFlame(p.renderPosition.x, p.renderPosition.y + 0.9, p.renderPosition.z, first ? 1 : 2, 0.35, 0.9); // burning
      if ((p.rocketTime > 0 || p.dashTime > 0) && !p.dead) this.rocketTrail(p.renderPosition.x, p.renderPosition.y + 0.9, p.renderPosition.z, p.velocity.x, p.velocity.y, p.velocity.z); // a glide boost or a dash
      this.sky.update(this.renderer.camera);
      this.audio.update(dt, this.renderer.camera, p, this.world);
      this._footsteps();
      this._swimSounds(dt);
      this.ui.hud.setCrosshairVisible(this.cameraController.perspective !== Perspective.THIRD_FRONT && !this.player.isSpectator); // no crosshair for a spectator
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
