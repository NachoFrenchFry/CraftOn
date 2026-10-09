// Particles.js — pooled camera-facing quads in one geometry: block-break chips (a random 4×4 texel
// sub-rectangle of the block's texture), smoke puffs, and critical-hit stars (the crit_star tile, spinning,
// fading out, slight gravity). Positions are rewritten per frame; nothing allocates while running.

import * as THREE from 'three';
import { FACE_TILE } from '../blocks/BlockRegistry.js';
import { TILE_UVS, TILE_SIZE, getTileIndex } from './AtlasLayout.js';
import { Direction } from '../utils/Direction.js';
import { GRAVITY } from '../config/Constants.js';

const MAX_PARTICLES = 768;
const SIZE = 0.09;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

export class ParticleSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Texture} atlasTexture
   * @param {import('../world/World.js').World} world
   */
  constructor(scene, atlasTexture, world) {
    this.world = world;
    /** Update #9 §7: 'all' | 'decreased' | 'minimal' scales every spawn count. */
    this.level = 'all';
    /** (x, y, z) → brightness factor of the sky light there (Update #10), set by Game. */
    this.lightAt = null;
    this.count = 0;
    this.pos = new Float32Array(MAX_PARTICLES * 3);
    this.vel = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.uvRect = new Float32Array(MAX_PARTICLES * 4);
    this.shade = new Float32Array(MAX_PARTICLES);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.tint = new Float32Array(MAX_PARTICLES * 3).fill(1);   // per-particle colour multiplier
    this.angle = new Float32Array(MAX_PARTICLES);              // billboard rotation (stars spin)
    this.spin = new Float32Array(MAX_PARTICLES);
    this.fade = new Uint8Array(MAX_PARTICLES);                 // 1 = alpha follows the remaining life
    this.gravityScale = new Float32Array(MAX_PARTICLES).fill(1);
    this.unlit = new Uint8Array(MAX_PARTICLES);                 // 1 = ignores the voxel light (flames glow in the dark)

    const positions = new Float32Array(MAX_PARTICLES * 4 * 3);
    const uvs = new Float32Array(MAX_PARTICLES * 4 * 2);
    const colors = new Float32Array(MAX_PARTICLES * 4 * 4);
    const indices = new Uint32Array(MAX_PARTICLES * 6);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const b = i * 4;
      indices.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.uvAttr = new THREE.BufferAttribute(uvs, 2);
    this.colAttr = new THREE.BufferAttribute(colors, 4); // rgba: vertex alpha fades the stars
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('uv', this.uvAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true, alphaTest: 0.1, transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.userData.noShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  /** Spawn n particles for a broken block. */
  /** Spawn count after the Particles setting (all / decreased 40 % / minimal 15 %, at least one). */
  _budget(n) { return this.level === 'all' ? n : Math.max(1, Math.round(n * (this.level === 'minimal' ? 0.15 : 0.4))); }

  spawnBlockBreak(x, y, z, blockId, n = 16) {
    n = this._budget(n);
    const tile = FACE_TILE[blockId * 6 + Direction.SOUTH];
    const t4 = tile * 4;
    const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
    const texel = (u1 - u0) / TILE_SIZE;
    for (let k = 0; k < n; k++) {
      if (this.count >= MAX_PARTICLES) return;
      const i = this.count++;
      const px = x + 0.15 + Math.random() * 0.7, py = y + 0.15 + Math.random() * 0.7, pz = z + 0.15 + Math.random() * 0.7;
      this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
      this.vel[i * 3] = (px - x - 0.5) * 4 + (Math.random() - 0.5) * 2;
      this.vel[i * 3 + 1] = Math.random() * 4 + 1.5;
      this.vel[i * 3 + 2] = (pz - z - 0.5) * 4 + (Math.random() - 0.5) * 2;
      this.maxLife[i] = this.life[i] = 0.6 + Math.random() * 0.4;
      const tx = Math.floor(Math.random() * (TILE_SIZE - 4)), ty = Math.floor(Math.random() * (TILE_SIZE - 4));
      this.uvRect[i * 4] = u0 + tx * texel;
      this.uvRect[i * 4 + 1] = v1 - (ty + 4) * texel;
      this.uvRect[i * 4 + 2] = u0 + (tx + 4) * texel;
      this.uvRect[i * 4 + 3] = v1 - ty * texel;
      this.shade[i] = 0.6 + Math.random() * 0.4;
      this.sizes[i] = SIZE * (0.7 + Math.random() * 0.6);
    }
  }
  /** Food crumbs (Update #9 §8): a few texels of an item icon from the mouth. */
  spawnItemCrumbs(x, y, z, tileIndex, n = 6) {
    n = this._budget(n);
    const tile = tileIndex;
    const t4 = tile * 4;
    const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
    const texel = (u1 - u0) / TILE_SIZE;
    for (let k = 0; k < n; k++) {
      if (this.count >= MAX_PARTICLES) return;
      const i = this.count++;
      const px = x + 0.15 + Math.random() * 0.7, py = y + 0.15 + Math.random() * 0.7, pz = z + 0.15 + Math.random() * 0.7;
      this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
      this.vel[i * 3] = (px - x - 0.5) * 4 + (Math.random() - 0.5) * 2;
      this.vel[i * 3 + 1] = Math.random() * 4 + 1.5;
      this.vel[i * 3 + 2] = (pz - z - 0.5) * 4 + (Math.random() - 0.5) * 2;
      this.maxLife[i] = this.life[i] = 0.6 + Math.random() * 0.4;
      const tx = Math.floor(Math.random() * (TILE_SIZE - 4)), ty = Math.floor(Math.random() * (TILE_SIZE - 4));
      this.uvRect[i * 4] = u0 + tx * texel;
      this.uvRect[i * 4 + 1] = v1 - (ty + 4) * texel;
      this.uvRect[i * 4 + 2] = u0 + (tx + 4) * texel;
      this.uvRect[i * 4 + 3] = v1 - ty * texel;
      this.shade[i] = 0.6 + Math.random() * 0.4;
      this.sizes[i] = SIZE * (0.7 + Math.random() * 0.6);
    }
  }

  /** Puff of soft white smoke (uses the snow tile's texels), drifting upward. */
  _reset(i) { this.tint[i * 3] = this.tint[i * 3 + 1] = this.tint[i * 3 + 2] = 1; this.angle[i] = 0; this.spin[i] = 0; this.fade[i] = 0; this.gravityScale[i] = 1; this.unlit[i] = 0; }

  /**
   * Flames (Update #11): tiny bright orange / yellow flecks from the torch texture's flame texels, rising and fading
   * in 0.25–0.5 s, lit by nothing (they glow). `spread` is the horizontal scatter, `rise` the upward speed.
   */
  spawnFlame(x, y, z, n = 2, spread = 0.06, rise = 0.6) {
    n = this._budget(n);
    const t4 = getTileIndex('torch') * 4;
    const u0 = TILE_UVS[t4], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
    const texel = (u1 - u0) / TILE_SIZE;
    for (let k = 0; k < n; k++) {
      if (this.count >= MAX_PARTICLES) return;
      const i = this.count++;
      this._reset(i);
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread * 2; this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * spread; this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread * 2;
      this.vel[i * 3] = (Math.random() - 0.5) * 0.25; this.vel[i * 3 + 1] = rise * (0.7 + Math.random() * 0.6); this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
      this.maxLife[i] = this.life[i] = 0.25 + Math.random() * 0.25;
      const tx = 6 + Math.floor(Math.random() * 3), ty = 1 + Math.floor(Math.random() * 4); // the flame texels (rows 1..5, cols 6..9)
      this.uvRect[i * 4] = u0 + tx * texel; this.uvRect[i * 4 + 1] = v1 - (ty + 1) * texel; this.uvRect[i * 4 + 2] = u0 + (tx + 1) * texel; this.uvRect[i * 4 + 3] = v1 - ty * texel;
      this.shade[i] = 1.3; this.sizes[i] = SIZE * (0.45 + Math.random() * 0.4);
      this.tint[i * 3] = 1; this.tint[i * 3 + 1] = 0.75 + Math.random() * 0.25; this.tint[i * 3 + 2] = 0.35;
      this.fade[i] = 1; this.gravityScale[i] = 0; this.unlit[i] = 1;
    }
  }

  /** Dark smoke (Update #11): a grey puff that rises slowly and fades (torch tips, sizzling lava). */
  spawnSmoke(x, y, z, n = 1, size = 1.1) {
    const before = this.count;
    this.spawnPuff(x, y, z, n, 22);
    for (let i = before; i < this.count; i++) {
      const g = 0.18 + Math.random() * 0.14;
      this.tint[i * 3] = this.tint[i * 3 + 1] = this.tint[i * 3 + 2] = g;
      this.shade[i] = 1; this.fade[i] = 1; this.sizes[i] = SIZE * size * (0.8 + Math.random() * 0.5);
      this.vel[i * 3] *= 0.5; this.vel[i * 3 + 2] *= 0.5; this.vel[i * 3 + 1] = 0.5 + Math.random() * 0.4; this.gravityScale[i] = 0;
      this.pos[i * 3] = x + (Math.random() - 0.5) * 0.12; this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.12; this.pos[i * 3 + 1] = y;
      this.maxLife[i] = this.life[i] = 0.9 + Math.random() * 0.6;
    }
  }

  /**
   * Critical hit: 40–60 bright white / yellow four-point stars spray outward and upward from the hit
   * point, spinning and fading over 0.6–0.9 s with slight gravity, plus a few sparkles on the body.
   */
  spawnCrit(x, y, z, n = 48, bodyHalfWidth = 0.45, bodyHeight = 1.2) {
    n = this._budget(n);
    const t4 = getTileIndex('crit_star') * 4;
    const u0 = TILE_UVS[t4], v0 = TILE_UVS[t4 + 1], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
    const star = (px, py, pz, vx, vy, vz, life, size, yellow) => {
      if (this.count >= MAX_PARTICLES) return;
      const i = this.count++;
      this._reset(i);
      this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
      this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
      this.maxLife[i] = this.life[i] = life;
      this.uvRect[i * 4] = u0; this.uvRect[i * 4 + 1] = v0; this.uvRect[i * 4 + 2] = u1; this.uvRect[i * 4 + 3] = v1;
      this.shade[i] = 1.25; this.sizes[i] = size;
      this.tint[i * 3] = 1; this.tint[i * 3 + 1] = yellow ? 0.92 : 1; this.tint[i * 3 + 2] = yellow ? 0.45 : 1;
      this.angle[i] = Math.random() * Math.PI * 2; this.spin[i] = (Math.random() - 0.5) * 16;
      this.fade[i] = 1; this.gravityScale[i] = 0.35;
    };
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI * 0.45 + 0.1, sp = 2.5 + Math.random() * 3.5;
      star(x + (Math.random() - 0.5) * 0.4, y + (Math.random() - 0.5) * 0.4, z + (Math.random() - 0.5) * 0.4,
        Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 1.0, Math.sin(a) * Math.cos(e) * sp,
        0.6 + Math.random() * 0.3, SIZE * (1.1 + Math.random() * 0.9), Math.random() < 0.55);
    }
    // Sparkles on the body: short-lived, nearly still.
    for (let k = 0; k < 8; k++) {
      star(x + (Math.random() - 0.5) * bodyHalfWidth * 2, y - bodyHeight * 0.6 + Math.random() * bodyHeight, z + (Math.random() - 0.5) * bodyHalfWidth * 2,
        (Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.5, (Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.25, SIZE * 1.4, true);
    }
  }

  /** Ordinary hit: a small puff of about 5 particles. */
  spawnHitPuff(x, y, z) { this.spawnPuff(x, y, z, 5, 22); }

  /** @deprecated kept for older callers: the small pre-Update-#6 star burst. */
  spawnCritSmall(x, y, z, n = 14, blockId = 22) {
    n = this._budget(n);
    const tile = FACE_TILE[blockId * 6 + Direction.SOUTH];
    const t4 = tile * 4;
    const u0 = TILE_UVS[t4], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
    const texel = (u1 - u0) / TILE_SIZE;
    for (let k = 0; k < n; k++) {
      if (this.count >= MAX_PARTICLES) return;
      const i = this.count++;
      this._reset(i);
      const a = Math.random() * Math.PI * 2, e = (Math.random() - 0.3) * Math.PI * 0.6, sp = 2.5 + Math.random() * 2.5;
      this.pos[i * 3] = x + (Math.random() - 0.5) * 0.6; this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * 0.6; this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.6;
      this.vel[i * 3] = Math.cos(a) * Math.cos(e) * sp; this.vel[i * 3 + 1] = Math.sin(e) * sp + 1.5; this.vel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * sp;
      this.maxLife[i] = this.life[i] = 0.25 + Math.random() * 0.25;
      const tx = Math.floor(Math.random() * (TILE_SIZE - 2)), ty = Math.floor(Math.random() * (TILE_SIZE - 2));
      this.uvRect[i * 4] = u0 + tx * texel; this.uvRect[i * 4 + 1] = v1 - (ty + 2) * texel; this.uvRect[i * 4 + 2] = u0 + (tx + 2) * texel; this.uvRect[i * 4 + 3] = v1 - ty * texel;
      this.shade[i] = 1.2; this.sizes[i] = SIZE * (0.8 + Math.random() * 0.6);
    }
  }

  spawnPuff(x, y, z, n = 10, blockId = 22) {
    n = this._budget(n);
    const tile = FACE_TILE[blockId * 6 + Direction.SOUTH];
    const t4 = tile * 4;
    const u0 = TILE_UVS[t4], u1 = TILE_UVS[t4 + 2], v1 = TILE_UVS[t4 + 3];
    const texel = (u1 - u0) / TILE_SIZE;
    for (let k = 0; k < n; k++) {
      if (this.count >= MAX_PARTICLES) return;
      const i = this.count++;
      this._reset(i);
      this.pos[i * 3] = x + (Math.random() - 0.5) * 0.8; this.pos[i * 3 + 1] = y + Math.random() * 0.8; this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.8;
      this.vel[i * 3] = (Math.random() - 0.5) * 0.6; this.vel[i * 3 + 1] = 1.2 + Math.random() * 0.8; this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
      this.maxLife[i] = this.life[i] = 0.7 + Math.random() * 0.5;
      const tx = Math.floor(Math.random() * (TILE_SIZE - 4)), ty = Math.floor(Math.random() * (TILE_SIZE - 4));
      this.uvRect[i * 4] = u0 + tx * texel; this.uvRect[i * 4 + 1] = v1 - (ty + 4) * texel; this.uvRect[i * 4 + 2] = u0 + (tx + 4) * texel; this.uvRect[i * 4 + 3] = v1 - ty * texel;
      this.shade[i] = 0.95; this.sizes[i] = SIZE * (1.6 + Math.random());
      this.vel[i * 3 + 1] += GRAVITY * 0.5 * this.maxLife[i] * 0.5; // counter most of the gravity so smoke rises
    }
  }

  _remove(i) {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) { this.pos[i * 3 + k] = this.pos[last * 3 + k]; this.vel[i * 3 + k] = this.vel[last * 3 + k]; }
    for (let k = 0; k < 4; k++) this.uvRect[i * 4 + k] = this.uvRect[last * 4 + k];
    for (let k = 0; k < 3; k++) this.tint[i * 3 + k] = this.tint[last * 3 + k];
    this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
    this.shade[i] = this.shade[last]; this.sizes[i] = this.sizes[last];
    this.angle[i] = this.angle[last]; this.spin[i] = this.spin[last]; this.fade[i] = this.fade[last]; this.gravityScale[i] = this.gravityScale[last]; this.unlit[i] = this.unlit[last];
  }

  update(dt, camera) {
    const world = this.world;
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this._remove(i); i--; continue; }
      const b = i * 3;
      this.vel[b + 1] -= GRAVITY * 0.5 * this.gravityScale[i] * dt;
      this.angle[i] += this.spin[i] * dt;
      let nx = this.pos[b] + this.vel[b] * dt, ny = this.pos[b + 1] + this.vel[b + 1] * dt, nz = this.pos[b + 2] + this.vel[b + 2] * dt;
      if (world.isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        if (world.isSolid(Math.floor(this.pos[b]), Math.floor(ny), Math.floor(this.pos[b + 2]))) {
          this.vel[b + 1] = 0; ny = this.pos[b + 1];
          this.vel[b] *= 0.6; this.vel[b + 2] *= 0.6;
        } else { this.vel[b] = 0; this.vel[b + 2] = 0; nx = this.pos[b]; nz = this.pos[b + 2]; }
      }
      this.pos[b] = nx; this.pos[b + 1] = ny; this.pos[b + 2] = nz;
    }
    // Rebuild billboards.
    const right = this._right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const P = this.posAttr.array, U = this.uvAttr.array, Cc = this.colAttr.array;
    for (let i = 0; i < this.count; i++) {
      const b = i * 3, s = this.sizes[i];
      const cx = this.pos[b], cy = this.pos[b + 1], cz = this.pos[b + 2];
      const ca = Math.cos(this.angle[i]), sa = Math.sin(this.angle[i]);
      const alpha = this.fade[i] ? Math.min(1, this.life[i] / (this.maxLife[i] * 0.6)) : 1;
      let lr = 1, lg = 1, lb = 1;
      if (!this.unlit[i] && this.lightAt) { const lf = this.lightAt(cx, cy, cz); if (typeof lf === 'number') lr = lg = lb = lf; else { lr = lf[0]; lg = lf[1]; lb = lf[2]; } } // sky + warm block light (Update #11)
      const r = this.shade[i] * this.tint[b] * lr, g = this.shade[i] * this.tint[b + 1] * lg, bl = this.shade[i] * this.tint[b + 2] * lb;
      for (let c = 0; c < 4; c++) {
        const sx0 = CORNERS[c][0], sy0 = CORNERS[c][1];
        const sx = sx0 * ca - sy0 * sa, sy = sx0 * sa + sy0 * ca; // spin around the view axis
        const o = (i * 4 + c) * 3;
        P[o] = cx + (right.x * sx + up.x * sy) * s;
        P[o + 1] = cy + (right.y * sx + up.y * sy) * s;
        P[o + 2] = cz + (right.z * sx + up.z * sy) * s;
        const uo = (i * 4 + c) * 2;
        U[uo] = sx0 < 0 ? this.uvRect[i * 4] : this.uvRect[i * 4 + 2];
        U[uo + 1] = sy0 < 0 ? this.uvRect[i * 4 + 1] : this.uvRect[i * 4 + 3];
        const co = (i * 4 + c) * 4;
        Cc[co] = r; Cc[co + 1] = g; Cc[co + 2] = bl; Cc[co + 3] = alpha;
      }
    }
    this.posAttr.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, this.count * 6);
    this.mesh.visible = this.count > 0;
  }
}
