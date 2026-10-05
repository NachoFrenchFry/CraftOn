// FractalNoise.js — fBm, ridged noise and domain warping built on SimplexNoise. Worker-safe.

/** Fractal Brownian motion, normalized to roughly [-1, 1]. */
export function fbm2(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise.noise2D(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(noise, x, y, z, octaves = 3, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise.noise3D(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]: sharp ridges where the noise crosses zero. */
export function ridged2(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise.noise2D(x * freq, y * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Domain warp: returns fbm sampled at a position offset by another noise field. */
export function warped2(noise, warpNoise, x, y, warpAmount, octaves = 4) {
  const wx = fbm2(warpNoise, x + 31.7, y + 17.3, 2) * warpAmount;
  const wy = fbm2(warpNoise, x - 12.1, y + 47.9, 2) * warpAmount;
  return fbm2(noise, x + wx, y + wy, octaves);
}
