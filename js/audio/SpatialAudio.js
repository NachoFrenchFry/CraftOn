// SpatialAudio.js — positional playback through PannerNodes and listener sync with the camera.

import * as THREE from 'three';

const MAX_DISTANCE = 16;

export class SpatialAudio {
  /** @param {AudioContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  /** Play a buffer at a world position into `dest`; returns the source node. */
  play(buffer, x, y, z, volume, rate, dest) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'linear';
    panner.maxDistance = MAX_DISTANCE;
    panner.refDistance = 1;
    panner.rolloffFactor = 1;
    if (panner.positionX) {
      panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z;
    } else {
      panner.setPosition(x, y, z);
    }
    src.connect(gain);
    gain.connect(panner);
    panner.connect(dest);
    src.start();
    return src;
  }

  /** Update the listener from a camera. */
  updateListener(camera) {
    const l = this.ctx.listener;
    const p = camera.position;
    this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(p.x, t); l.positionY.setValueAtTime(p.y, t); l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(this._fwd.x, t); l.forwardY.setValueAtTime(this._fwd.y, t); l.forwardZ.setValueAtTime(this._fwd.z, t);
      l.upX.setValueAtTime(this._up.x, t); l.upY.setValueAtTime(this._up.y, t); l.upZ.setValueAtTime(this._up.z, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
    }
  }
}
