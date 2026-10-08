// BreakOverlay.js — the 10-stage crack overlay drawn slightly outside the block being mined.

import * as THREE from 'three';
import { createBlockGeometry } from './BlockGeometry.js';
import { getTileIndex, CRACK_STAGES } from './AtlasLayout.js';
import { BlockIds } from '../blocks/BlockIds.js';

export class BreakOverlay {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Texture} atlasTexture
   */
  constructor(scene, atlasTexture) {
    this.geometries = [];
    for (let i = 0; i < CRACK_STAGES; i++) {
      this.geometries.push(createBlockGeometry(BlockIds.STONE, 1.004, true, getTileIndex('crack_' + i)));
    }
    const mat = new THREE.MeshBasicMaterial({
      map: atlasTexture, transparent: true, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, vertexColors: false,
    });
    this.mesh = new THREE.Mesh(this.geometries[0], mat);
    this.mesh.userData.noShadow = true;
    this.mesh.visible = false;
    this.mesh.renderOrder = 9;
    scene.add(this.mesh);
    this.stage = -1;
  }

  /** progress in [0, 1); hides when < 0. */
  update(x, y, z, progress) {
    if (progress < 0) { this.mesh.visible = false; this.stage = -1; return; }
    const stage = Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES));
    if (stage !== this.stage) { this.mesh.geometry = this.geometries[stage]; this.stage = stage; }
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; this.stage = -1; }
}
