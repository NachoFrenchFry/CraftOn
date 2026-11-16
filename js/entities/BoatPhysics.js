// BoatPhysics.js — the boat's movement step (Nov 15 2026, part 2 of 2), pure so tools/check-boat.mjs can run it without
// the game. The velocity lives in world space and the thrust follows the heading, so on ice a boat keeps sliding the old
// way while it turns and drifts through corners (that is the point of ice racing). Minecraft's boat numbers: a thrust of
// 0.04 blocks per 20 Hz tick² (16 blocks/s²) and a friction of 0.9 on water, 0.98 on ice, 0.6 on land per 20 Hz tick —
// per 60 Hz tick the drags below (the cube roots) and the top speeds 8 / 40 / 2 blocks/s. Like Movement.js the thrust is
// written as top speed × (1 − drag) per tick, so the top speeds are exact at any frame rate, and the step is integrated
// exactly over dt (the exponential approach to the steady speed, with its displacement), so 20, 60 and 120 FPS end at the
// same place. In the air there is no thrust: the boat keeps its speed while it falls.

export const TICK = 1 / 60;
/** Minecraft's boat: 1.375 wide and long, 0.5625 high. */
export const BOAT_WIDTH = 1.375;
export const BOAT_HEIGHT = 0.5625;
/** Drag per 60 Hz tick by what is under the boat (Minecraft's 0.9 / 0.98 / 0.6 per 20 Hz tick, and 0.98 in the air). */
export const BOAT_DRAG = Object.freeze({ water: 0.9655, ice: 0.9933, ground: 0.8434, air: 0.9933 });
/** Top speed (blocks/s) on each surface; the thrust is top × (1 − drag) per tick (about 16 blocks/s² from rest on water and ice). */
export const BOAT_TOP_SPEED = Object.freeze({ water: 8, ice: 40, ground: 2 });
/** Minecraft's thrust, for the record: 0.04 blocks per 20 Hz tick² = 16 blocks/s²; backward a quarter of it. */
export const BOAT_THRUST = 16;
export const BOAT_BACK_FACTOR = 0.25;
/** Left / right turn the heading at up to this rate, easing in and out over BOAT_TURN_EASE seconds; the same on every surface. */
export const BOAT_TURN_RATE = 150 * Math.PI / 180;
export const BOAT_TURN_EASE = 0.2;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/** The heading's unit direction in world space (CraftOn: yaw 0 looks toward −Z, growing yaw turns left toward −X). */
export function headingOf(yaw, out = { x: 0, z: 0 }) { out.x = -Math.sin(yaw); out.z = -Math.cos(yaw); return out; }

/** The drag's continuous rate (per second) and the time to reach a share of the top speed from rest. */
export function dragRate(surface) { return -Math.log(BOAT_DRAG[surface] || BOAT_DRAG.air) / TICK; }
export function timeToFraction(surface, fraction = 0.9) { return -Math.log(1 - fraction) / dragRate(surface); }
/** Coasting distance from `speed` with no input on `surface` (the exponential's whole tail). */
export function coastDistance(surface, speed) { return speed / dragRate(surface); }

/**
 * One step of the heading and the horizontal velocity. `state` is { yaw, turnRate, vx, vz } (mutated); `input` is
 * { forward: −1..1 (back is a quarter as strong), turn: −1..1 (+1 = left) }; `surface` one of 'water' | 'ice' | 'ground' |
 * 'air'; `dt` the game seconds of the step. Writes the step's horizontal displacement into `out` ({ dx, dz }) — the exact
 * integral of the velocity over the step, which the caller hands to the collision sweep as a velocity (dx / dt, dz / dt).
 */
export function boatStep(state, input, surface, dt, out) {
  if (!(dt > 0)) { out.dx = 0; out.dz = 0; return out; }
  // The heading: the turn rate eases toward the requested one (in and out, over BOAT_TURN_EASE); the boat turns by the
  // integral of that rate over the step, and the thrust below follows the step's average heading — both exact in dt, so
  // a turn at 20 FPS traces the same curve as at 120.
  const wantRate = clamp(input.turn || 0, -1, 1) * BOAT_TURN_RATE;
  const a = Math.exp(-dt / BOAT_TURN_EASE);
  const r0 = state.turnRate;
  const dYaw = wantRate * dt + (r0 - wantRate) * BOAT_TURN_EASE * (1 - a);
  state.turnRate = wantRate + (r0 - wantRate) * a;
  const midYaw = state.yaw + dYaw / 2;
  state.yaw = wrapAngle(state.yaw + dYaw);
  // Drag and thrust, exactly over dt: v(t) = T + (v0 − T) e^(−c t), with T the steady velocity the input asks for along the
  // heading (top speed forward, a quarter backward, nothing in the air) and c the drag's continuous rate.
  const c = dragRate(surface);
  const e = Math.exp(-c * dt);
  const top = surface === 'air' ? 0 : BOAT_TOP_SPEED[surface] || 0;
  const f = clamp(input.forward || 0, -1, 1);
  const speed = top * (f > 0 ? f : f * BOAT_BACK_FACTOR);
  const tx = -Math.sin(midYaw) * speed, tz = -Math.cos(midYaw) * speed;
  const k = (1 - e) / c; // ∫ e^(−c t) dt over the step
  out.dx = (state.vx - tx) * k + tx * dt;
  out.dz = (state.vz - tz) * k + tz * dt;
  state.vx = tx + (state.vx - tx) * e;
  state.vz = tz + (state.vz - tz) * e;
  return out;
}
