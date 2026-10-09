// DebugOverlay.js — the F3 information screen, updated at most 4× per second.

import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { compassFromYaw } from '../utils/Direction.js';
import { biomeName } from '../generation/Biomes.js';
import { radToDeg } from '../utils/MathUtils.js';

export class DebugOverlay {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('debug-overlay');
    this.visible = false;
    this.timer = 0;
    this.lines = [];
    for (let i = 0; i < 16; i++) {
      const el = document.createElement('div');
      el.className = 'debug-line';
      this.root.appendChild(el);
      this.root.appendChild(document.createElement('br'));
      this.lines.push(el);
    }
  }

  toggle() {
    this.visible = !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    if (this.visible) this.refresh();
  }

  update(dt) {
    if (!this.visible) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    this.refresh();
  }

  _set(i, text) {
    const el = this.lines[i];
    if (el.textContent !== text) el.textContent = text;
    el.style.display = text ? '' : 'none';
  }

  refresh() {
    const g = this.game;
    const p = g.player;
    const pos = p.position;
    const stats = g.chunkManager ? g.chunkManager.stats() : { loaded: 0, meshes: 0, meshPending: 0, genQueue: 0 };
    const info = g.renderer.info;
    const t = g.interaction ? g.interaction.target : null;
    const f = (n) => n.toFixed(3);
    let i = 0;
    this._set(i++, `CraftOn  ${g.loop.fps} fps  (${g.loop.fps > 0 ? (1000 / g.loop.fps).toFixed(1) : '-'} ms)`);
    this._set(i++, `XYZ: ${f(pos.x)} / ${f(pos.y)} / ${f(pos.z)}`);
    this._set(i++, `Block: ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}   Chunk: ${Math.floor(pos.x) >> 4} ${Math.floor(pos.z) >> 4}  (${Math.floor(pos.x) & 15} ${Math.floor(pos.z) & 15})`);
    this._set(i++, `Facing: ${compassFromYaw(p.yaw)}  yaw ${radToDeg(p.yaw).toFixed(1)}  pitch ${radToDeg(p.pitch).toFixed(1)}`);
    this._set(i++, `Biome: ${biomeName(g.world.getBiome(Math.floor(pos.x), Math.floor(pos.z)))}`);
    this._set(i++, `Chunks: ${stats.loaded} loaded  meshes ${stats.meshes}  pending ${stats.meshPending}  gen queue ${stats.genQueue}  light pending ${stats.lightPending}  light queue ${stats.lightQueue}`);
    const lt = g.chunkManager.lightTiming, lu = g.chunkManager.lightUpdater.timing;
    this._set(i++, `Light: sky ${g.world.getSkyLightAt(pos.x, pos.y + 0.5, pos.z)} / block ${g.world.getBlockLightAt(pos.x, pos.y + 0.5, pos.z)} at feet, sky ${g.world.getSkyLightAt(pos.x, pos.y + 1.6, pos.z)} / block ${g.world.getBlockLightAt(pos.x, pos.y + 1.6, pos.z)} at eyes   initial pass avg ${lt.count ? (lt.total / lt.count).toFixed(1) : '-'} ms   edit update avg ${lu.count ? (lu.total / lu.count).toFixed(2) : '-'} ms   brightness ${g.settings.get('brightness')}%`);
    this._set(i++, `Draw calls: ${g.renderer.worldStats.calls}  triangles: ${g.renderer.worldStats.triangles}  geometries: ${info.memory.geometries}`);
    this._set(i++, `Seed: ${g.world.seed}${g.worldMeta && g.worldMeta.seedText ? ` ("${g.worldMeta.seedText}")` : ''}`);
    this._set(i++, t && t.hit ? `Target: ${BlockRegistry.nameOf(t.blockId)} at ${t.blockPos.x} ${t.blockPos.y} ${t.blockPos.z}` : 'Target: none');
    this._set(i++, `Mode: ${p.gameMode}  ${p.flying ? 'flying ' : ''}${p.sprinting ? 'sprinting ' : ''}${p.sneaking ? 'sneaking ' : ''}${p.inWater ? 'in water ' : ''}${p.onGround ? 'on ground' : 'airborne'}   swimming: ${p.swimming}${p.crawling ? ' (crawling)' : ''}`);
    this._set(i++, `Perspective: ${['first person', 'third person (back)', 'third person (front)'][g.cameraController.perspective]}   Items: ${g.entities.items.length}   Armor: ${g.inventory.armorPoints()}`);
    const rs = g.settings.get('renderScale');
    this._set(i++, `Render scale: ${Math.round(g.renderer.renderScale * 100)}%${rs === 0 ? ' (auto)' : ''}   FPS cap: ${g.loop.maxFps > 0 ? g.loop.maxFps : 'unlimited'}   Sim distance: ${g.settings.get('simulationDistance')} chunks   Shaders: ${g.settings.get('shadersOn') ? g.settings.get('shaderPreset') : 'off'}`);
    for (; i < this.lines.length; i++) this._set(i, '');
  }
}
