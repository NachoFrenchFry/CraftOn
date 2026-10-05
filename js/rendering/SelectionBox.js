// SelectionBox.js — thin dark wireframe around the targeted block (shrunk for plants).

import * as THREE from 'three';
import { RENDER_TYPE, RenderType } from '../blocks/BlockRegistry.js';

export class SelectionBox {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    const geom = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthTest: true, fog: false });
    this.lines = new THREE.LineSegments(geom, mat);
    this.lines.visible = false;
    this.lines.renderOrder = 10;
    scene.add(this.lines);
  }

  /** @param {import('../player/BlockRaycaster.js').RaycastHit} target */
  update(target) {
    if (!target.hit) { this.lines.visible = false; return; }
    this.lines.visible = true;
    const p = target.blockPos;
    if (RENDER_TYPE[target.blockId] === RenderType.CROSS) {
      this.lines.scale.set(0.7, 0.8, 0.7);
      this.lines.position.set(p.x + 0.5, p.y + 0.4, p.z + 0.5);
    } else {
      this.lines.scale.set(1, 1, 1);
      this.lines.position.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
    }
  }

  hide() { this.lines.visible = false; }
}
