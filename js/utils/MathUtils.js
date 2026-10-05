// MathUtils.js — small numeric helpers used across the codebase (worker-safe).

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Positive modulo: mod(-1, 16) === 15. */
export const mod = (n, m) => ((n % m) + m) % m;
export const floorDiv = (n, d) => Math.floor(n / d);
export const degToRad = (d) => (d * Math.PI) / 180;
export const radToDeg = (r) => (r * 180) / Math.PI;
export const TWO_PI = Math.PI * 2;

/** Smallest signed angle difference a - b in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/** Piecewise-linear spline through sorted [x, y] points. */
export function splineEval(points, x) {
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return last[1];
}

/** 32-bit integer hash (lowbias32). */
export function hashInt(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Hash three integers into one 32-bit value. */
export function hash3(a, b, c) {
  let h = hashInt(a | 0);
  h = hashInt(h ^ Math.imul(b | 0, 0x9e3779b1));
  h = hashInt(h ^ Math.imul(c | 0, 0x85ebca77));
  return h >>> 0;
}

/** Exponential smoothing factor independent of frame rate. */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
