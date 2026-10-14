// AudioManager.js — lazy AudioContext (resumed on the first gesture), buses with settings-driven volumes, the SoundBank
// of real audio files (one file per sound, audio/<category>/<sound>.<ext> through audio/manifest.json, loaded in the
// background from boot, most-used first; the menu never waits and a sound not loaded yet is skipped), spatial playback,
// footsteps and the ambient loops (the wind is a looping file, nothing is synthesized at runtime). Variation is done in
// code: every play shifts the pitch and the volume by a random amount set per sound in the manifest (strong for blocks,
// none for UI sounds and loops) and never repeats the exact pitch of the previous play of that sound.

import { SoundBank } from './SoundBank.js';
import { SpatialAudio } from './SpatialAudio.js';
import { soundId } from './SoundIds.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { BlockIds } from '../blocks/BlockIds.js';
import { SEA_LEVEL } from '../config/Constants.js';

const MAX_VOICES = 24;
const RETRIGGER_MS = 30;
const BUS_SETTING = { blocks: 'blocksVolume', player: 'playerVolume', ambient: 'ambientVolume', ui: 'uiVolume' };

/** A looping buffer (the wind bed) with a smoothed level and a /tick playback rate. */
class LoopPlayer {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(dest);
    this.src = null;
    this.rate = 1;
  }
  get started() { return !!this.src; }
  start(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = Math.max(0.0001, this.rate);
    src.connect(this.gain);
    src.start();
    this.src = src;
  }
  /** Smoothly move toward a target volume (0..1). */
  setLevel(level, time) { this.gain.gain.setTargetAtTime(level, time, 1.5); }
  setRate(rate) { this.rate = rate; if (this.src) this.src.playbackRate.setTargetAtTime(Math.max(0.0001, rate), this.ctx.currentTime, 0.05); }
}

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
    /** /tick: every buffer source plays at this rate, so sped-up footage sounds normal. */
    this.timeScale = 1;
    this._dripTimer = 20 + Math.random() * 40;
    this._enclosed = false;
    this._nearWater = false;
    /** id → the playback rate of its last play (the next one is pushed away from it). */
    this._lastPitch = new Map();
    events.on('settings:changed', (key) => { if (key.endsWith('Volume')) this.applyVolumes(); });
    const unlock = () => this.init();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  /** Start loading every sound file in the background (small batches, yielding between them). Safe to call more than once. */
  prerender() {
    return this.bank.renderInBackground();
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
    this.wind = new LoopPlayer(ctx, this.buses.ambient); // starts once audio/ambient/wind is decoded (update())
    this.wind.setRate(this.timeScale);
    this.ready = true; // sounds still loading in the background are skipped until their buffers exist
    this.events.emit('audio:ready');
    await this.prerender(); // no-op when boot already started it
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

  /**
   * The playback rate for one play of a sound: 1 ± the manifest's `pitch`, never the same as the previous play of that
   * sound (a repeat is pushed to the other half of the range), so fast footsteps or mining never sound robotic.
   */
  pitchFor(id) {
    const spread = this.bank.pitchOf(id);
    if (spread <= 0) return 1;
    const last = this._lastPitch.get(id);
    let rate = 1 + (Math.random() * 2 - 1) * spread;
    if (last !== undefined && Math.abs(rate - last) < spread * 0.3) rate = last > 1 ? 1 - Math.random() * spread : 1 + Math.random() * spread;
    this._lastPitch.set(id, rate);
    return rate;
  }

  /** The gain multiplier for one play: the manifest volume × (1 ± `volumeVar`). */
  gainFor(id) {
    const spread = this.bank.volumeVarOf(id);
    return this.bank.volumeOf(id) * (spread > 0 ? 1 + (Math.random() * 2 - 1) * spread : 1);
  }

  /** Non-positional playback. `name` is a sound id ("ui/click") or the old dotted name ("ui.click"); `rate` overrides the random pitch. */
  play(name, bus = 'ui', volume = 1, rate = null) {
    const id = soundId(name);
    if (!this._canPlay(id)) return;
    const buffer = this.bank.get(id);
    if (!buffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = (rate ?? this.pitchFor(id)) * this.timeScale;
    const gain = ctx.createGain();
    gain.gain.value = volume * this.gainFor(id);
    src.connect(gain);
    gain.connect(this.buses[bus] || this.buses.ui);
    this.activeVoices++;
    src.onended = () => { this.activeVoices--; };
    src.start();
  }

  /** Positional playback through the blocks bus. */
  playAt(name, x, y, z, bus = 'blocks', volume = 1, rate = null) {
    const id = soundId(name);
    if (!this._canPlay(id)) return;
    const buffer = this.bank.get(id);
    if (!buffer) return;
    this.activeVoices++;
    const src = this.spatial.play(buffer, x, y, z, volume * this.gainFor(id), (rate ?? this.pitchFor(id)) * this.timeScale, this.buses[bus] || this.buses.blocks);
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
      if (!this.wind.started) { const buffer = this.bank.get('ambient/wind'); if (buffer) this.wind.start(buffer); }
      const y = player.position.y;
      let level = 0.12 + Math.max(0, (y - 100) / 120) * 0.35;
      if (this._enclosed) level *= 0.25;
      if (player.headInWater || player.headInLava) level *= 0.1;
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
      const buffer = this.bank.get('ambient/water');
      if (!buffer) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = Math.max(0.0001, this.timeScale);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.35 * this.bank.volumeOf('ambient/water')), this.ctx.currentTime + 1.5);
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

  /** /tick: scale every sound (new ones and the running loops). 0 while frozen mutes nothing but stops the loops' motion. */
  setTimeScale(scale) {
    this.timeScale = Math.max(0, scale);
    if (this.waterLoop && this.ctx) this.waterLoop.src.playbackRate.setTargetAtTime(Math.max(0.0001, this.timeScale), this.ctx.currentTime, 0.05);
    if (this.wind) this.wind.setRate(this.timeScale);
  }

  /** Stop ambient loops (leaving a world). */
  stopAmbient() {
    this._nearWater = false;
    this._updateWaterLoop();
    if (this.wind) this.wind.setLevel(0, this.ctx.currentTime);
  }
}
