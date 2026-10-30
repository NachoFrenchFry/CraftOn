// Glide.js — Minecraft's elytra and firework arithmetic, pure and per 20 Hz tick, in blocks per tick (the physics
// converts from and to blocks per second). `v` is mutated in place. `look` is the unit look vector; `pitch` is CraftOn's
// (positive = looking up), so the "looking up" term uses sin(pitch) where Minecraft's uses −sin(pitch).

/** One elytra tick: gravity softened by the wings, lift from the horizontal speed, diving into speed, steering toward the look. */
export function glideTick(v, look, pitch) {
  const hl = Math.hypot(look.x, look.z);
  const hv = Math.hypot(v.x, v.z);
  const c = Math.cos(pitch) * Math.cos(pitch) * Math.min(1, Math.hypot(look.x, look.y, look.z) / 0.4);
  v.y += -0.08 + c * 0.06;
  if (v.y < 0 && hl > 0) { const k = v.y * -0.1 * c; v.y += k; v.x += look.x / hl * k; v.z += look.z / hl * k; }
  if (pitch > 0 && hl > 0) { const k = hv * Math.sin(pitch) * 0.04; v.y += k * 3.2; v.x -= look.x / hl * k; v.z -= look.z / hl * k; }
  if (hl > 0) { v.x += (look.x / hl * hv - v.x) * 0.1; v.z += (look.z / hl * hv - v.z) * 0.1; }
  v.x *= 0.99; v.y *= 0.98; v.z *= 0.99;
  return v;
}

/** One firework-boost tick: v += L × 0.1 + (L × 1.5 − v) × 0.5 — it converges on 1.5 blocks per tick (30 blocks/s). */
export function rocketTick(v, look) {
  v.x += look.x * 0.1 + (look.x * 1.5 - v.x) * 0.5;
  v.y += look.y * 0.1 + (look.y * 1.5 - v.y) * 0.5;
  v.z += look.z * 0.1 + (look.z * 1.5 - v.z) * 0.5;
  return v;
}

/** Crash damage before armor from the horizontal speed lost in one tick (blocks per tick): (lost × 10 − 3) × 5 when positive. */
export function crashDamage(lostPerTick) { return Math.max(0, (lostPerTick * 10 - 3) * 5); }

/** Simulate `ticks` ticks of a level glide from `speed` blocks/s at `pitch` (a quick Node check and a tuning aid); returns blocks/s. */
export function simulateGlide(speed, pitch, ticks, look = null) {
  const L = look || { x: Math.cos(pitch), y: Math.sin(pitch), z: 0 };
  const v = { x: L.x / Math.hypot(L.x, L.z) * speed / 20, y: 0, z: 0 };
  for (let i = 0; i < ticks; i++) glideTick(v, L, pitch);
  return { x: v.x * 20, y: v.y * 20, z: v.z * 20, speed: Math.hypot(v.x, v.y, v.z) * 20 };
}
