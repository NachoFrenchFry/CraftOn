// AudioManager.js — lazy AudioContext (resumed on the first gesture), buses with settings-driven
// volumes, the pre-rendered SoundBank, spatial playback, footsteps and ambient loops. Sounds are rendered in
// the background from boot (OfflineAudioContext needs no gesture), most-used first; the menu never waits for
// them and a sound whose buffer is not ready yet is skipped.

import { SoundBank } from './SoundBank.js';
import { SpatialAudio } from './SpatialAudio.js';
import { registerBlockSounds } from './recipes/BlockSounds.js';
import { registerPlayerSounds } from './recipes/PlayerSounds.js';
import { registerUISounds } from './recipes/UISounds.js';
import { registerAmbientSounds, WindLoop } from './recipes/AmbientSounds.js';
import { registerMobSounds } from './recipes/MobSounds.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { SEA_LEVEL } from '../config/Constants.js';

const MAX_VOICES = 24;
const RETRIGGER_MS = 30;
const BUS_SETTING = { blocks: 'blocksVolume', player: 'playerVolume', ambient: 'ambientVolume', ui: 'uiVolume' };
/** Render order for the background pre-render: what plays first in a session comes first. */
const PRERENDER_PRIORITY = ['ui.', 'player.', 'grass.', 'dirt.', 'stone.', 'wood.', 'sand.', 'gravel.', 'plant.', 'glass.', 'water.', 'wool.', 'mob.', 'ambient.'];
const PRERENDER_SAMPLE_RATE = 48000;

export class AudioManager {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../core/EventBus.js').EventBus} events
   */
  constructor(settings, events) {
    this.settings = settings;
    this.events = events;
    this.ctx = null;
    this.buses = null;
    this.bank = new SoundBank();
    this.spatial = null;
    this.wind = null;
    this.waterLoop = null;
    this.activeVoices = 0;
    this.lastPlay = new Map();
    this.ready = false;
    this.initStarted = false;
    this._ambientTimer = 0;
    this._dripTimer = 20 + Math.random() * 40;
    this._enclosed = false;
    this._nearWater = false;
    registerBlockSounds(this.bank);
    registerPlayerSounds(this.bank);
    registerUISounds(this.bank);
    registerAmbientSounds(this.bank);
    registerMobSounds(this.bank);
    events.on('settings:changed', (key) => { if (key.endsWith('Volume')) this.applyVolumes(); });
    const unlock = () => this.init();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  /** Start rendering every sound in the background (small batches, yielding between them). Safe to call more than once. */
  prerender(sampleRate = PRERENDER_SAMPLE_RATE) {
    return this.bank.renderInBackground(sampleRate, PRERENDER_PRIORITY);
  }

  /** Create the context on the first user gesture; playback starts at once with whatever sounds are rendered. */
  async init() {
    if (this.initStarted) { this.resume(); return; }
    this.initStarted = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
    } catch (e) {
      console.warn('AudioManager: Web Audio unavailable', e);
      return;
    }
    const ctx = this.ctx;
    const master = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.ratio.value = 4;
    master.connect(compressor);
    compressor.connect(ctx.destination);
    this.buses = { master };
    for (const name of ['blocks', 'player', 'ambient', 'ui']) {
      const g = ctx.createGain();
      g.connect(master);
      this.buses[name] = g;
    }
    this.applyVolumes();
    this.spatial = new SpatialAudio(ctx);
    this.resume();
    this.wind = new WindLoop(ctx, this.buses.ambient);
    this.ready = true; // sounds still rendering in the background are skipped until their buffers exist
    this.events.emit('audio:ready');
    await this.prerender(ctx.sampleRate); // no-op when boot already started it
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  applyVolumes() {
    if (!this.buses) return;
    this.buses.master.gain.value = this.settings.get('masterVolume');
    for (const [bus, key] of Object.entries(BUS_SETTING)) this.buses[bus].gain.value = this.settings.get(key);
  }

  _canPlay(name) {
    if (!this.ready || !this.ctx || this.ctx.state !== 'running') return false;
    if (this.activeVoices >= MAX_VOICES) return false;
    const now = performance.now();
    const last = this.lastPlay.get(name) || 0;
    if (now - last < RETRIGGER_MS) return false;
    this.lastPlay.set(name, now);
    return true;
  }

  /** Non-positional playback. */
  play(name, bus = 'ui', volume = 1, rate = null) {
    if (!this._canPlay(name)) return;
    const buffer = this.bank.get(name);
    if (!buffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate ?? (0.9 + Math.random() * 0.2);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.buses[bus] || this.buses.ui);
    this.activeVoices++;
    src.onended = () => { this.activeVoices--; };
    src.start();
  }

  /** Positional playback through the blocks bus. */
  playAt(name, x, y, z, bus = 'blocks', volume = 1, rate = null) {
    if (!this._canPlay(name)) return;
    const buffer = this.bank.get(name);
    if (!buffer) return;
    this.activeVoices++;
    const src = this.spatial.play(buffer, x, y, z, volume, rate ?? (0.9 + Math.random() * 0.2), this.buses[bus]);
    src.onended = () => { this.activeVoices--; };
  }

  /** Block material sound: kind ∈ break | place | hit | step. */
  playBlock(kind, blockId, x, y, z, volume = 1) {
    const group = BlockRegistry.soundGroup(blockId);
    this.playAt(`${group}.${kind}`, x, y, z, 'blocks', volume);
  }

  /** Footstep for the block under the player (non-spatial, quiet). */
  playStep(blockId, volume = 0.3, rate = null) {
    if (blockId === BlockIds.AIR) return;
    const group = BlockRegistry.soundGroup(blockId);
    this.play(`${group}.step`, 'player', volume, rate);
  }

  playUI(name, volume = 1) { this.play('ui.' + name, 'ui', volume); }
  playPlayer(name, volume = 1, rate = null) { this.play('player.' + name, 'player', volume, rate); }

  /**
   * Per-frame: listener sync and ambient levels.
   * @param {import('../world/World.js').World} world
   */
  update(dt, camera, player, world) {
    if (!this.ready) return;
    this.spatial.updateListener(camera);
    this._ambientTimer -= dt;
    if (this._ambientTimer <= 0) {
      this._ambientTimer = 1;
      this._probeSurroundings(player, world);
    }
    if (this.wind) {
      const y = player.position.y;
      let level = 0.12 + Math.max(0, (y - 100) / 120) * 0.35;
      if (this._enclosed) level *= 0.25;
      if (player.headInWater) level *= 0.1;
      this.wind.setLevel(Math.min(level, 0.5), this.ctx.currentTime);
    }
    this._updateWaterLoop();
    // Rare cave ambience when enclosed and deep.
    this._dripTimer -= dt;
    if (this._dripTimer <= 0) {
      this._dripTimer = 30 + Math.random() * 90;
      if (this._enclosed && player.position.y < 50) {
        const p = player.position;
        const a = Math.random() * Math.PI * 2;
        this.playAt(Math.random() < 0.6 ? 'ambient.drip' : 'ambient.cave', p.x + Math.cos(a) * 6, p.y + 2, p.z + Math.sin(a) * 6, 'ambient', 0.5);
      }
    }
  }

  _probeSurroundings(player, world) {
    const px = Math.floor(player.position.x), py = Math.floor(player.position.y), pz = Math.floor(player.position.z);
    let enclosed = false;
    for (let y = py + 2; y < Math.min(py + 30, 256); y++) if (world.isOpaque(px, y, pz)) { enclosed = true; break; }
    this._enclosed = enclosed;
    let water = false;
    for (let dx = -3; dx <= 3 && !water; dx += 3) for (let dz = -3; dz <= 3 && !water; dz += 3) {
      for (let dy = -2; dy <= 1; dy++) if (world.isLiquid(px + dx, py + dy, pz + dz)) { water = true; break; }
    }
    this._nearWater = water || player.position.y < SEA_LEVEL + 1 && player.inWater;
  }

  _updateWaterLoop() {
    if (this._nearWater && !this.waterLoop) {
      const buffer = this.bank.get('ambient.water');
      if (!buffer) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.35, this.ctx.currentTime + 1.5);
      src.connect(gain);
      gain.connect(this.buses.ambient);
      src.start();
      this.waterLoop = { src, gain };
    } else if (!this._nearWater && this.waterLoop) {
      const { src, gain } = this.waterLoop;
      this.waterLoop = null;
      gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.5);
      setTimeout(() => { try { src.stop(); } catch (e) { /* already stopped */ } }, 2500);
    }
  }

  /** Stop ambient loops (leaving a world). */
  stopAmbient() {
    this._nearWater = false;
    this._updateWaterLoop();
    if (this.wind) this.wind.setLevel(0, this.ctx.currentTime);
  }
}
