// Interpolator.js — a small buffer of timed snapshots rendered INTERP_DELAY behind the newest one, so remote
// players and mobs move smoothly between 20 Hz / 12 Hz updates, and extrapolated with the last velocity for up
// to EXTRAPOLATE_MAX when a packet is late. Angles are interpolated the short way round. Pure.

import { INTERP_DELAY, EXTRAPOLATE_MAX } from './Protocol.js';
import { angleDelta } from '../utils/MathUtils.js';

export class Interpolator {
  constructor() {
    /** @type {{ t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, yaw: number, pitch: number, extra: any }[]} */
    this.buffer = [];
    this.out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, extra: null, extrapolating: false };
    this.lastReceived = -Infinity;
  }

  get hasData() { return this.buffer.length > 0; }

  /** Add a snapshot received at local time `t` (seconds). */
  push(t, x, y, z, vx, vy, vz, yaw, pitch, extra = null) {
    const last = this.buffer[this.buffer.length - 1];
    if (last && t <= last.t) t = last.t + 1e-4; // keep the buffer monotonic
    this.buffer.push({ t, x, y, z, vx, vy, vz, yaw, pitch, extra });
    if (this.buffer.length > 32) this.buffer.shift();
    this.lastReceived = t;
    if (this.buffer.length === 1) Object.assign(this.out, { x, y, z, yaw, pitch, vx, vy, vz, extra });
  }

  /** Teleport: forget the past. */
  reset() { this.buffer.length = 0; }

  /** Sample the state for local time `now` (seconds). */
  sample(now) {
    const buf = this.buffer, o = this.out;
    if (!buf.length) return o;
    const target = now - INTERP_DELAY;
    let a = null, b = null;
    for (let i = buf.length - 1; i >= 0; i--) { if (buf[i].t <= target) { a = buf[i]; b = buf[i + 1] || null; break; } }
    if (!a) { // target is older than everything we have: hold the oldest snapshot
      const s = buf[0]; Object.assign(o, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, vx: s.vx, vy: s.vy, vz: s.vz, extra: s.extra, extrapolating: false });
      return o;
    }
    if (b) {
      const k = Math.min(1, Math.max(0, (target - a.t) / Math.max(1e-4, b.t - a.t)));
      o.x = a.x + (b.x - a.x) * k; o.y = a.y + (b.y - a.y) * k; o.z = a.z + (b.z - a.z) * k;
      o.yaw = a.yaw + angleDelta(b.yaw, a.yaw) * k; o.pitch = a.pitch + (b.pitch - a.pitch) * k;
      o.vx = b.vx; o.vy = b.vy; o.vz = b.vz; o.extra = k < 0.5 ? a.extra : b.extra; o.extrapolating = false;
    } else {
      // No newer snapshot: extrapolate with the last velocity for a short while, then hold still.
      const dt = Math.min(EXTRAPOLATE_MAX, Math.max(0, target - a.t));
      o.x = a.x + a.vx * dt; o.y = a.y + a.vy * dt; o.z = a.z + a.vz * dt;
      o.yaw = a.yaw; o.pitch = a.pitch; o.vx = a.vx; o.vy = a.vy; o.vz = a.vz; o.extra = a.extra; o.extrapolating = dt > 0;
    }
    // Drop snapshots older than two seconds behind the target.
    while (buf.length > 2 && buf[1].t < target - 2) buf.shift();
    return o;
  }
}
