// LookSmoothing.js — the Smooth Camera's math (Nov 14 2026): a first-order lag between the mouse and the camera, for
// recording. Mouse movement goes into a "still to turn" amount that is paid out over time, so the camera eases into a turn
// and glides to a stop; the total turn is exactly the mouse's, only the timing changes. Pure (no game, no DOM) so
// tools/check-look-smoothing.mjs can run it. The controller keeps a `pending` object and calls lookStep() once per frame.
//
// The payout uses the exponential form, so it is frame-rate independent: over a frame of `dt` seconds the pending amount
// shrinks by e^(−dt/τ), i.e. the share k = 1 − e^(−dt/τ) is applied. The frame's own fresh movement arrived spread over
// that frame (the mouse moves continuously between frames), so its share is the exact response of the lag to a steady
// input over dt: 1 − (τ/dt)·k (about k/2 for short frames). With that, a steady pan ends at the same angle at 20, 60 and
// 120 FPS to the last digit; applying the full k to the fresh movement too would put a 20 FPS pan about 3 % ahead.

/** The default Smooth Camera Time (seconds): the `smoothCameraTime` setting. */
export const SMOOTH_CAMERA_TIME_DEFAULT = 0.35;
/** A leftover under this many radians is paid out at once, so a glide ends instead of trailing on forever. */
const SNAP = 1e-6;

/** The share of a pending turn applied over `dt` seconds with time constant `tau` (1 − e^(−dt/τ)); 1 when no smoothing is possible. */
export function smoothShare(dt, tau) {
  if (!(tau > 0) || !(dt > 0)) return 1;
  return -Math.expm1(-dt / tau);
}

/** The share of movement that arrived spread over a frame of `dt` seconds and is applied within that same frame: 1 − (τ/dt)·k. */
export function freshShare(dt, tau) {
  if (!(tau > 0) || !(dt > 0)) return 1;
  return 1 + Math.expm1(-dt / tau) / (dt / tau);
}

/** A new pending record for a controller (or a test). */
export function makePending() { return { pendingYaw: 0, pendingPitch: 0 }; }

/** Drop whatever is still to turn (the mode switched, the controller disabled, a teleport). */
export function clearPending(pending) { pending.pendingYaw = 0; pending.pendingPitch = 0; }

/**
 * One frame of the smooth camera. `dx` / `dy` are this frame's mouse turn in radians (sensitivity and invert already
 * applied: the amounts the plain look would apply at once), `dt` the real seconds since the last frame, `tau` the
 * Smooth Camera Time. Writes the yaw / pitch amounts to apply this frame into `out` and the rest into `pending`.
 */
export function lookStep(pending, dx, dy, dt, tau, out) {
  const k = smoothShare(dt, tau), kFresh = freshShare(dt, tau);
  out.yaw = pending.pendingYaw * k + dx * kFresh;
  out.pitch = pending.pendingPitch * k + dy * kFresh;
  pending.pendingYaw += dx - out.yaw;
  pending.pendingPitch += dy - out.pitch;
  if (Math.abs(pending.pendingYaw) < SNAP) { out.yaw += pending.pendingYaw; pending.pendingYaw = 0; }
  if (Math.abs(pending.pendingPitch) < SNAP) { out.pitch += pending.pendingPitch; pending.pendingPitch = 0; }
  return out;
}
