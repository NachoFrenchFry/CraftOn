// TorchEffects.js — flame and smoke particles over every torch near the player (Update #11). Torch positions are
// read from the block arrays of the chunks around the player (cached per chunk version, so a chunk is rescanned
// only after an edit); a torch within TORCH_EFFECT_RANGE blocks sheds a small flame fleck about once a second and a
// wisp of smoke now and then, scaled by the Particles setting.
import { CHUNK_SIZE } from '../config/Constants.js';
import { RENDER_TYPE, RenderType, BlockRegistry } from '../blocks/BlockRegistry.js';
import { torchTip } from '../blocks/TorchModel.js';
import { chunkKey, blockIndex } from '../world/ChunkCoords.js';

export const TORCH_EFFECT_RANGE = 28;
const FLAME_RATE = 1.6;   // flames per second per torch (at the 'all' setting)
const SMOKE_RATE = 0.35;

export class TorchEffects {
  /**
   * @param {import('../world/World.js').World} world
   * @param {import('./Particles.js').ParticleSystem} particles
   */
  constructor(world, particles) {
    this.world = world;
    this.particles = particles;
    /** chunk key → { version, list: number[] of [wx, y, wz, id, ...] } */
    this.cache = new Map();
    this.enabled = true;
    this.count = 0;
  }

  clear() { this.cache.clear(); }

  /** Torches of a chunk (world coordinates), rescanned when its version changed. */
  torchesOf(chunk) {
    const key = chunkKey(chunk.cx, chunk.cz);
    let e = this.cache.get(key);
    if (e && e.version === chunk.version) return e.list;
    const list = [];
    const b = chunk.blocks;
    for (let sy = 0; sy < 16; sy++) {
      if (chunk.sectionCounts[sy] === 0) continue;
      for (let y = sy * 16; y < sy * 16 + 16; y++) for (let col = 0; col < 256; col++) {
        const id = b[blockIndex(col & 15, y, col >> 4)];
        if (RENDER_TYPE[id] === RenderType.TORCH) list.push(chunk.cx * CHUNK_SIZE + (col & 15), y, chunk.cz * CHUNK_SIZE + (col >> 4), id);
      }
    }
    if (!e) { e = { version: chunk.version, list }; this.cache.set(key, e); } else { e.version = chunk.version; e.list = list; }
    // Forget chunks that are gone.
    if (this.cache.size > 64) for (const k of this.cache.keys()) if (!this.world.chunks.has(k)) this.cache.delete(k);
    return list;
  }

  update(dt, px, py, pz) {
    if (!this.enabled || dt <= 0) return;
    const level = this.particles.level;
    const scale = level === 'all' ? 1 : level === 'decreased' ? 0.4 : 0.15;
    const r = Math.ceil(TORCH_EFFECT_RANGE / CHUNK_SIZE);
    const ccx = Math.floor(px) >> 4, ccz = Math.floor(pz) >> 4;
    let count = 0;
    for (let cz = ccz - r; cz <= ccz + r; cz++) for (let cx = ccx - r; cx <= ccx + r; cx++) {
      const chunk = this.world.getChunk(cx, cz);
      if (!chunk) continue;
      const list = this.torchesOf(chunk);
      for (let i = 0; i < list.length; i += 4) {
        const x = list[i], y = list[i + 1], z = list[i + 2];
        if (Math.abs(x - px) > TORCH_EFFECT_RANGE || Math.abs(z - pz) > TORCH_EFFECT_RANGE || Math.abs(y - py) > TORCH_EFFECT_RANGE) continue;
        count++;
        const tip = torchTip(BlockRegistry.attachOf(list[i + 3]));
        if (Math.random() < dt * FLAME_RATE * scale) this.particles.spawnFlame(x + tip[0], y + tip[1], z + tip[2], 1, 0.03, 0.45);
        if (Math.random() < dt * SMOKE_RATE * scale) this.particles.spawnSmoke(x + tip[0], y + tip[1] + 0.1, z + tip[2], 1, 0.7);
      }
    }
    this.count = count;
  }
}
