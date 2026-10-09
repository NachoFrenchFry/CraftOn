// SelectionBox.js — thin dark wireframe around the targeted block (shrunk for plants).

import * as THREE from 'three';
import { RENDER_TYPE, RenderType, BlockRegistry } from '../blocks/BlockRegistry.js';
import { torchBounds } from '../blocks/TorchModel.js';

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
    } else if (RENDER_TYPE[target.blockId] === RenderType.TORCH) {
      // A small box around the torch model (Update #11), a little wider than the 2 px stick so it is easy to see.
      const b = torchBounds(BlockRegistry.attachOf(target.blockId));
      const pad = 0.04;
      this.lines.scale.set(b.max[0] - b.min[0] + pad * 2, b.max[1] - b.min[1] + pad, b.max[2] - b.min[2] + pad * 2);
      this.lines.position.set(p.x + (b.min[0] + b.max[0]) / 2, p.y + (b.min[1] + b.max[1]) / 2, p.z + (b.min[2] + b.max[2]) / 2);
    } else {
      this.lines.scale.set(1, 1, 1);
      this.lines.position.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
    }
  }

  hide() { this.lines.visible = false; }
}
