// Glide.js — Minecraft's elytra and firework arithmetic, pure and per 20 Hz tick, in blocks per tick (the physics
// converts from and to blocks per second). `v` is mutated in place. `look` is the unit look vector; `pitch` is CraftOn's
// (positive = looking up), so the "looking up" term uses sin(pitch) where Minecraft's uses −sin(pitch). The boost tick's
// two numbers come from Constants (ROCKET_BOOST_ACCEL / ROCKET_BOOST_TARGET, Minecraft's 0.1 / 1.5) and can be passed in.

import { ROCKET_BOOST_ACCEL, ROCKET_BOOST_TARGET } from '../config/Constants.js';

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

/**
 * One firework-boost tick: v += L × accel + (L × target − v) × 0.5. On its own it converges on L × (target + 2 × accel) blocks per tick;
 * with the glide tick's drag and gravity running beside it a little under that. The defaults are the game's (ROCKET_BOOST_ACCEL 0.1,
 * ROCKET_BOOST_TARGET 1.5, Minecraft's numbers: 1.7 per tick, about 17 blocks/s with GLIDE_SPEED_SCALE 0.5).
 */
export function rocketTick(v, look, accel = ROCKET_BOOST_ACCEL, target = ROCKET_BOOST_TARGET) {
  v.x += look.x * accel + (look.x * target - v.x) * 0.5;
  v.y += look.y * accel + (look.y * target - v.y) * 0.5;
  v.z += look.z * accel + (look.z * target - v.z) * 0.5;
  return v;
}

/**
 * A boost from a settled level glide: `glideSeconds` of level gliding from `speed` blocks/s, then `boostSeconds` of boosting (the glide
 * tick and the boost tick each 20 Hz tick, look level) with the given boost numbers; returns the speed in blocks/s at `scale`.
 */
export function simulateBoost(speed, glideSeconds, boostSeconds, scale = 1, accel = ROCKET_BOOST_ACCEL, target = ROCKET_BOOST_TARGET) {
  const L = { x: 1, y: 0, z: 0 }, k = 20 * scale;
  const v = { x: speed / k, y: 0, z: 0 };
  for (let i = 0; i < Math.round(glideSeconds * 20); i++) glideTick(v, L, 0);
  for (let i = 0; i < Math.round(boostSeconds * 20); i++) { glideTick(v, L, 0); rocketTick(v, L, accel, target); }
  return Math.hypot(v.x, v.y, v.z) * k;
}

/** Crash damage before armor from the horizontal speed lost in one tick (blocks per tick): (lost × 10 − 3) × 5 when positive. */
export function crashDamage(lostPerTick) { return Math.max(0, (lostPerTick * 10 - 3) * 5); }

/**
 * Simulate `ticks` ticks of a glide from `speed` blocks/s at `pitch` (a quick Node check and a tuning aid); returns blocks/s plus the
 * distance flown per block dropped. `scale` is the physics' GLIDE_SPEED_SCALE: blocks per tick ↔ blocks per second convert with 20 × scale,
 * so with 0.5 every speed halves while the path shape and the glide ratio stay the same.
 */
export function simulateGlide(speed, pitch, ticks, look = null, scale = 1) {
  const L = look || { x: Math.cos(pitch), y: Math.sin(pitch), z: 0 };
  const k = 20 * scale;
  const v = { x: L.x / Math.hypot(L.x, L.z) * speed / k, y: 0, z: 0 };
  let dx = 0, dy = 0;
  for (let i = 0; i < ticks; i++) { glideTick(v, L, pitch); dx += Math.hypot(v.x, v.z); dy += v.y; }
  return { x: v.x * k, y: v.y * k, z: v.z * k, speed: Math.hypot(v.x, v.y, v.z) * k, ratio: dy < 0 ? dx / -dy : Infinity };
}
