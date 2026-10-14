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
    for (let i = 0; i < 18; i++) {
      const el = document.createElement('div');
      el.className = 'debug-line';
      this.root.appendChild(el);
      this.root.appendChild(document.createElement('br'));
      this.lines.push(el);
    }
    // The performance graph: one bar per frame (240 frames), green under 16.7 ms, yellow under 33, red above.
    this.graph = document.createElement('canvas');
    this.graph.id = 'debug-graph';
    this.graph.width = 240; this.graph.height = 60;
    this.root.appendChild(this.graph);
    this.gfx = this.graph.getContext('2d');
  }

  toggle() {
    this.visible = !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    if (this.visible) this.refresh();
  }

  update(dt) {
    if (!this.visible) return;
    this._drawGraph();
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    this.refresh();
  }

  _drawGraph() {
    const pr = this.game.profiler, ctx = this.gfx, w = this.graph.width, h = this.graph.height;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, w, h);
    const scale = h / 50; // 50 ms = full height
    const n = pr.interval.length;
    for (let i = 0; i < w; i++) {
      const v = pr.interval[(pr.pos - w + i + n * 2) % n];
      const c = pr.cpu[(pr.pos - w + i + n * 2) % n];
      const bh = Math.min(h, v * scale);
      ctx.fillStyle = v > 33 ? '#e0483a' : v > 16.8 ? '#e8c43a' : '#5ad05a';
      ctx.fillRect(i, h - bh, 1, bh);
      const ch = Math.min(h, c * scale);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillRect(i, h - ch, 1, 1);
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fillRect(0, h - 16.7 * scale, w, 1);
    ctx.fillRect(0, h - 33.3 * scale, w, 1);
  }

  _set(i, text) {
    const el = this.lines[i];
    if (el.textContent !== text) el.textContent = text;
    el.style.display = text ? '' : 'none';
  }

  /** how each connection travels (LAN / Direct / Relay (TURN)) and its ping; empty in single player. */
  _networkLine() {
    const net = this.game.net;
    if (!net) return '';
    const relay = net.ice ? (net.ice.turn ? 'TURN ok' : 'STUN only') : 'ICE pending';
    if (net.isHost) {
      const peers = [...net.peers.values()].map((p) => `${p.name || p.userId.slice(0, 6)}: ${p.link.connectionType || 'connecting'} ${Math.round(p.link.rtt)} ms`);
      return `Network: hosting (${net.visibility}, ${relay}) · ${net.playerCount}/${net.maxPlayers} players${peers.length ? ' · ' + peers.join(' · ') : ''}`;
    }
    const rp = this.game.remotePlayers.get(net.hostId);
    const interp = rp && rp.interp ? ` · interp ${Math.round(rp.interp.delay * 1000)} ms (jitter ${Math.round(rp.interp.jitter * 1000)} ms)` : '';
    return `Network: guest of ${net.welcome ? net.welcome.hostName : 'host'} (${relay}) · ${net.link && net.link.connectionType || 'connecting'} · ping ${net.link ? Math.round(net.link.rtt) : 0} ms${interp}`;
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
    this._set(i++, `CraftOn  ${g.loop.fps} fps  (${g.loop.fps > 0 ? (1000 / g.loop.fps).toFixed(1) : '-'} ms)   Tick: ${g.tick.rate} TPS (${(g.tick.rate / 20).toFixed(2)}×)${g.tick.frozen ? ' FROZEN' : ''}`);
    this._set(i++, `XYZ: ${f(pos.x)} / ${f(pos.y)} / ${f(pos.z)}`);
    this._set(i++, `Block: ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}   Chunk: ${Math.floor(pos.x) >> 4} ${Math.floor(pos.z) >> 4}  (${Math.floor(pos.x) & 15} ${Math.floor(pos.z) & 15})`);
    this._set(i++, `Facing: ${compassFromYaw(p.yaw)}  yaw ${radToDeg(p.yaw).toFixed(1)}  pitch ${radToDeg(p.pitch).toFixed(1)}`);
    this._set(i++, `Biome: ${biomeName(g.world.getBiome(Math.floor(pos.x), Math.floor(pos.z)))}`);
    this._set(i++, `Chunks: ${stats.loaded} loaded  meshes ${stats.meshes}  pending ${stats.meshPending}  gen queue ${stats.genQueue}  light pending ${stats.lightPending}  light queue ${stats.lightQueue}`);
    const lt = g.chunkManager.lightTiming, lu = g.chunkManager.lightUpdater.timing;
    this._set(i++, `Light: sky ${g.world.getSkyLightAt(pos.x, pos.y + 0.5, pos.z)} / block ${g.world.getBlockLightAt(pos.x, pos.y + 0.5, pos.z)} at feet, sky ${g.world.getSkyLightAt(pos.x, pos.y + 1.6, pos.z)} / block ${g.world.getBlockLightAt(pos.x, pos.y + 1.6, pos.z)} at eyes   initial pass avg ${lt.count ? (lt.total / lt.count).toFixed(1) : '-'} ms   edit update avg ${lu.count ? (lu.total / lu.count).toFixed(2) : '-'} ms   brightness ${g.settings.get('brightness')}%`);
    const vs = g.meshManager.stats;
    this._set(i++, `Draw calls: ${g.renderer.worldStats.calls}  triangles: ${g.renderer.worldStats.triangles}  geometries: ${info.memory.geometries}   culling: ${vs.visible} of ${vs.sections} sections in ${vs.chunksVisible} chunks (${g.visibility.lastMs.toFixed(2)} ms)`);
    this._set(i++, `Seed: ${g.world.seed}${g.worldMeta && g.worldMeta.seedText ? ` ("${g.worldMeta.seedText}")` : ''}`);
    this._set(i++, t && t.hit ? `Target: ${BlockRegistry.nameOf(t.blockId)} at ${t.blockPos.x} ${t.blockPos.y} ${t.blockPos.z}` : 'Target: none');
    this._set(i++, `Mode: ${p.gameMode}  ${p.flying ? 'flying ' : ''}${p.sprinting ? 'sprinting ' : ''}${p.sneaking ? 'sneaking ' : ''}${p.inWater ? 'in water ' : ''}${p.onGround ? 'on ground' : 'airborne'}   swimming: ${p.swimming}${p.crawling ? ' (crawling)' : ''}`);
    this._set(i++, `Perspective: ${['first person', 'third person (back)', 'third person (front)'][g.cameraController.perspective]}   Items: ${g.entities.items.length}   Armor: ${g.inventory.armorPoints()}`);
    this._set(i++, this._networkLine());
    const rs = g.settings.get('renderScale');
    this._set(i++, `Render scale: ${Math.round(g.renderer.renderScale * 100)}%${rs === 0 ? ' (auto)' : ''}   FPS cap: ${g.loop.maxFps > 0 ? g.loop.maxFps : 'unlimited'}   Sim distance: ${g.settings.get('simulationDistance')} chunks   Shaders: ${g.settings.get('shadersOn') ? g.settings.get('shaderPreset') : 'off'}`);
    const pr = g.profiler;
    this._set(i++, `Frame: ${pr.lastInterval.toFixed(1)} ms (cpu ${pr.lastCpu.toFixed(1)} ms)   longest frame ${pr.longestFrame.toFixed(0)} ms   longest task ${pr.longestTask.toFixed(0)} ms (${pr.longTasks} over 50 ms)   water pending ${g.waterSim.pendingCount} lava ${g.lavaSim.pendingCount}`);
    this._set(i++, 'Systems (ms/frame): ' + pr.breakdown().slice(0, 12).map(([n, v]) => `${n} ${v.toFixed(2)}`).join('  '));
    for (; i < this.lines.length; i++) this._set(i, '');
  }
}
