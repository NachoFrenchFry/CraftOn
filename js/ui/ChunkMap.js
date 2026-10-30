// ChunkMap.js — the chunk-state debug map on the F3 screen (also forced on with ?chunkmap): a small top-down map
// around the player, one cell per chunk column, coloured by state — not generated, generating, generated, lit, meshed,
// drawn (meshed inside the render-distance circle), retrying, stuck, failed. The render-distance circle and the player are drawn over it, so a chunk or tile that never loads is visible at a glance.

const CELL = 3;                 // pixels per chunk column
const HALF = 32;                // columns shown on each side of the player
const REFRESH_SECONDS = 0.5;

import { chunkKey } from '../world/ChunkCoords.js';

export const CHUNK_MAP_COLORS = Object.freeze({
  none: '#101418', generating: '#3b3b6b', generated: '#6b6b6b', lit: '#7a8ba8', meshed: '#3f7f3f', drawn: '#5ad05a',
  retrying: '#e8c43a', stuck: '#ff8c00', failed: '#e0483a',
});

export class ChunkMap {
  /** @param {import('../core/Game.js').Game} game @param {HTMLElement} root the F3 overlay root */
  constructor(game, root) {
    this.game = game;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'chunk-map';
    this.canvas.width = this.canvas.height = (HALF * 2 + 1) * CELL;
    this.canvas.title = 'Chunk state map: one cell per chunk column';
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.timer = 0;
    this.visible = false;
    this.draws = 0;
  }

  setVisible(on) { this.visible = on; this.canvas.style.display = on ? '' : 'none'; if (on) this.draw(); }

  update(dt) {
    if (!this.visible) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REFRESH_SECONDS;
    this.draw();
  }

  /** The state colour of chunk column (cx, cz) for the player's chunk (pcx, pcz). */
  colorOf(cx, cz, pcx, pcz) {
    const g = this.game, cm = g.chunkManager;
    const key = chunkKey(cx, cz);
    const chunk = g.world.chunks.get(key);
    const C = CHUNK_MAP_COLORS;
    if (cm.isFailed(key)) return C.failed;
    if (cm.isRetrying(key)) return C.retrying;
    if (cm.stuckKeys.has(key)) return C.stuck;
    if (chunk) {
      const dx = cx - pcx, dz = cz - pcz, rd = cm.renderDistance;
      const drawn = chunk.meshed && (dx * dx + dz * dz <= rd * rd || !(g.visibility && g.visibility.enabled));
      if (drawn) return C.drawn;
      if (chunk.meshed) return C.meshed;
      if (chunk.lit) return C.lit;
      return C.generated;
    }
    if (cm.genInFlight.has(key)) return C.generating;
    return C.none;
  }

  draw() {
    const g = this.game;
    if (!g.world || !g.chunkManager) return;
    const p = g.player.position, pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
    const ctx = this.ctx, size = this.canvas.width;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    for (let dz = -HALF; dz <= HALF; dz++) for (let dx = -HALF; dx <= HALF; dx++) {
      ctx.fillStyle = this.colorOf(pcx + dx, pcz + dz, pcx, pcz);
      ctx.fillRect((dx + HALF) * CELL, (dz + HALF) * CELL, CELL - 1, CELL - 1);
    }
    // The render-distance circle (the drawn set).
    const centre = (HALF + 0.5) * CELL;
    const rd = g.chunkManager.renderDistance;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath(); ctx.arc(centre, centre, (rd + 0.5) * CELL, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillRect(HALF * CELL, HALF * CELL, CELL, CELL);
    this.draws++;
  }
}
