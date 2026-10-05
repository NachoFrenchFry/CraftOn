// Movement.js — velocity + drag horizontal movement (Update #5), pure and worker-free so it can be checked
// in Node. Each physics tick: velocity *= drag, then velocity += direction × accel while a key is held.
// The steady state is accel / (1 − drag), so accel = targetSpeed × (1 − drag) keeps the old top speeds
// (walk 4.317 b/s, sprint 5.612 b/s). Ground drag 0.83 per 60 Hz tick ≈ Minecraft's 0.546 per 20 Hz tick;
// a stronger brake drag applies on the ground with no input so a sprint stops within about 0.25 s.

export const GROUND_DRAG = 0.83;
export const GROUND_BRAKE_DRAG = 0.75;   // no input on the ground: full sprint → < 0.1 b/s in 15 ticks
export const AIR_DRAG = 0.97;
export const AIR_ACCEL_FACTOR = 0.2;     // air control: a fifth of the ground acceleration
export const FLY_DRAG = 0.82;           // creative / spectator flight: much less floaty (Update #6)
export const FLY_BRAKE_DRAG = 0.72;     // no input while flying: full sprint-fly stops (< 0.1 b/s) within ~0.3 s
export const TICK = 1 / 60;

/**
 * Advance the horizontal velocity `v` ({x, z}, mutated) by one physics step.
 * @param {{x:number,z:number}} v
 * @param {number} dirX input direction (unit or zero)
 * @param {number} dirZ
 * @param {number} targetSpeed top speed for the current pose (walk / sprint / sneak / fly)
 * @param {'ground'|'air'|'fly'} mode
 * @param {number} dt seconds (drag and accel are defined per 60 Hz tick and scaled to dt)
 */
export function stepHorizontal(v, dirX, dirZ, targetSpeed, mode, dt = TICK) {
  const ticks = dt / TICK;
  const pushing = dirX !== 0 || dirZ !== 0;
  let baseDrag, drag, accelScale;
  if (mode === 'fly') { baseDrag = FLY_DRAG; drag = pushing ? FLY_DRAG : FLY_BRAKE_DRAG; accelScale = 1; }
  else if (mode === 'air') { baseDrag = GROUND_DRAG; drag = AIR_DRAG; accelScale = AIR_ACCEL_FACTOR; }
  else { baseDrag = GROUND_DRAG; drag = pushing ? GROUND_DRAG : GROUND_BRAKE_DRAG; accelScale = 1; }
  const accel = targetSpeed * (1 - baseDrag) * accelScale * ticks;
  const k = Math.pow(drag, ticks);
  v.x *= k; v.z *= k;
  if (pushing) { v.x += dirX * accel; v.z += dirZ * accel; }
  return v;
}

/** Vertical flight: the same velocity + drag model on one axis (dirY = -1, 0 or 1). Returns the new vy. */
export function stepFlyVertical(vy, dirY, targetSpeed, dt = TICK) {
  const ticks = dt / TICK;
  const drag = dirY !== 0 ? FLY_DRAG : FLY_BRAKE_DRAG;
  vy *= Math.pow(drag, ticks);
  if (dirY !== 0) vy += dirY * targetSpeed * (1 - FLY_DRAG) * ticks;
  return vy;
}

/** Ticks needed from rest to reach `fraction` of the top speed on the ground (for checks and docs). */
export function ticksToReach(fraction, drag = GROUND_DRAG) {
  return Math.ceil(Math.log(1 - fraction) / Math.log(drag));
}
