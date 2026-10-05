// RemotePlayer.js — what you see of another player (Update #8): the full third-person PlayerModel driven by
// interpolated snapshots (walking, sneaking, swimming with the flutter kick, crawling, flying, head yaw /
// pitch), the held item, the 3D armor layer, swing animations, the mining crack overlay on the block they are
// breaking, spatial footsteps / splash / swim sounds, and a username nametag that faces the camera and hides
// while sneaking. Spectators are invisible to players who are not spectators themselves.

import * as THREE from 'three';
import { PlayerModel } from '../player/models/PlayerModel.js';
import { BreakOverlay } from '../rendering/BreakOverlay.js';
import { Interpolator } from './Interpolator.js';
import { decodePlayerState } from './Protocol.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { PLAYER_HEIGHT, SWIM_STROKE_INTERVAL } from '../config/Constants.js';

const STEP_DISTANCE = 1.6;
const NAMETAG_HEIGHT = PLAYER_HEIGHT + 0.45;

function makeNametag(name) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 40px sans-serif';
  const w = Math.ceil(ctx.measureText(name).width) + 32;
  canvas.width = Math.max(64, w); canvas.height = 56;
  ctx.font = 'bold 40px sans-serif';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(canvas.width / 160, canvas.height / 160, 1);
  sprite.renderOrder = 20;
  sprite.name = 'nametag';
  return sprite;
}

export class RemotePlayer {
  /**
   * @param {string} id user id
   * @param {string} name username
   * @param {import('../core/Game.js').Game} game
   */
  constructor(id, name, game) {
    this.id = id;
    this.name = name;
    this.game = game;
    this.scene = game.renderer.scene;
    this.model = new PlayerModel(game.blockModelMaterial, game.atlas, game.entityTextures);
    this.model.root.visible = false;
    this.model.root.name = 'remote:' + name;
    this.scene.add(this.model.root);
    this.nametag = makeNametag(name);
    this.nametag.visible = false;
    this.scene.add(this.nametag);
    this.overlay = new BreakOverlay(this.scene, game.atlas.texture);
    this.interp = new Interpolator();
    /** The fields PlayerModel.update reads, filled from the interpolated snapshot. */
    this.state = {
      renderPosition: new THREE.Vector3(), yaw: 0, pitch: 0, horizontalSpeed: 0, sprinting: false, flying: false, inWater: false,
      onGround: true, swimming: false, crawling: false, swimTime: 0, velocity: { x: 0, y: 0, z: 0 }, sneaking: false, spectator: false,
    };
    this.held = 0;
    this.armor = null;
    this.mode = 'survival';
    this.visible = false;
    this.walkAcc = 0;
    this.lastPos = null;
    this.swimTimer = 0;
    this.wasInWater = false;
    this.mineTimer = 0;
  }

  /** @param {number} t local receive time (s); @param {number[]} a snapshot array */
  snapshot(t, a) {
    this.interp.push(t, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8] | 0);
  }

  setMeta(meta) {
    if (meta.held !== undefined && meta.held !== this.held) { this.held = meta.held; this.model.setHeldItem(this.held); }
    if (meta.armor !== undefined) { this.armor = meta.armor; this.model.setArmor(this.armor); }
    if (meta.mode) this.mode = meta.mode;
  }

  swing() { this.model.swing(); }

  mining(x, y, z, progress) { this.overlay.update(x, y, z, progress); this.mineTimer = 1.5; }
  miningStop() { this.overlay.hide(); this.mineTimer = 0; }

  /** Per frame: interpolate, animate the model, nametag, sounds. */
  update(dt, now, localPlayer, audio, world) {
    const o = this.interp.sample(now);
    if (!this.interp.hasData) return;
    const st = this.state;
    const s = decodePlayerState([o.x, o.y, o.z, o.vx, o.vy, o.vz, o.yaw, o.pitch, o.extra | 0]);
    st.renderPosition.set(o.x, o.y, o.z);
    st.yaw = s.yaw; st.pitch = s.pitch;
    st.onGround = s.onGround; st.sneaking = s.sneaking; st.swimming = s.swimming; st.crawling = s.crawling;
    st.flying = s.flying; st.inWater = s.inWater; st.sprinting = s.sprinting; st.spectator = s.spectator;
    st.velocity.x = s.vx; st.velocity.y = s.vy; st.velocity.z = s.vz;
    st.horizontalSpeed = Math.hypot(s.vx, s.vz);
    if (st.swimming) st.swimTime += dt * Math.max(0.5, Math.hypot(s.vx, s.vy, s.vz) / 5.5);
    const visible = !st.spectator || localPlayer.isSpectator;
    this.visible = visible;
    this.model.root.visible = visible;
    if (visible) this.model.update(dt, st);
    this.nametag.visible = visible && !st.sneaking;
    this.nametag.position.set(o.x, o.y + (st.crawling || st.swimming ? 0.9 : NAMETAG_HEIGHT), o.z);
    if (this.mineTimer > 0) { this.mineTimer -= dt; if (this.mineTimer <= 0) this.overlay.hide(); }
    // Sounds at their position: footsteps from the distance they cover on the ground, a splash on entering
    // water fast, strokes while sprint-swimming.
    if (audio) {
      if (this.lastPos && st.onGround && !st.inWater && !st.flying && visible) {
        this.walkAcc += Math.hypot(o.x - this.lastPos.x, o.z - this.lastPos.z);
        if (this.walkAcc >= STEP_DISTANCE) {
          this.walkAcc = 0;
          const under = world.getBlock(Math.floor(o.x), Math.floor(o.y - 0.05), Math.floor(o.z));
          if (under) audio.playAt(`${BlockRegistry.soundGroup(under)}.step`, o.x, o.y, o.z, 'blocks', 0.25);
        }
      } else this.walkAcc = 0;
      if (st.inWater && !this.wasInWater && s.vy < -3 && visible) audio.playAt('player.splash', o.x, o.y, o.z, 'player', 0.8);
      if (st.swimming && visible) { this.swimTimer -= dt; if (this.swimTimer <= 0) { this.swimTimer = SWIM_STROKE_INTERVAL; audio.playAt('player.swim', o.x, o.y, o.z, 'player', 0.4); } }
      else this.swimTimer = 0;
    }
    this.wasInWater = st.inWater;
    if (!this.lastPos) this.lastPos = new THREE.Vector3();
    this.lastPos.set(o.x, o.y, o.z);
  }

  /** Last interpolated position (for the host's reach / pickup checks it uses the raw snapshot instead). */
  get position() { return this.state.renderPosition; }

  dispose() {
    this.scene.remove(this.model.root);
    this.scene.remove(this.nametag);
    this.scene.remove(this.overlay.mesh);
    if (this.nametag.material.map) this.nametag.material.map.dispose();
    this.nametag.material.dispose();
  }
}

/** Every other player in the session, by user id. */
export class RemotePlayerManager {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {Map<string, RemotePlayer>} */
    this.players = new Map();
  }

  get count() { return this.players.size; }

  add(id, name) {
    if (this.players.has(id)) return this.players.get(id);
    const rp = new RemotePlayer(id, name, this.game);
    this.players.set(id, rp);
    return rp;
  }

  get(id) { return this.players.get(id) || null; }

  remove(id) {
    const rp = this.players.get(id);
    if (!rp) return;
    rp.dispose();
    this.players.delete(id);
  }

  clear() { for (const id of [...this.players.keys()]) this.remove(id); }

  update(dt) {
    if (!this.players.size) return;
    const g = this.game;
    const now = performance.now() / 1000;
    for (const rp of this.players.values()) rp.update(dt, now, g.player, g.audio, g.world);
  }
}
