// TerrainShaper.js — the height function: continentalness, erosion, ridged hills, a dedicated peaks layer
// (Update #8: sharp ridged ranges up to y ~220 where the land is continental and unerod­ed, gated by a slow
// "range" field so ranges are rarer than plains), wide valleys between high ground that drop toward sea level
// with a river in their deepest band, and detail noise, combined with piecewise-linear splines. Also samples
// temperature / humidity for biome selection. Pure & deterministic per (seed, x, z). Worker-safe.

import { SimplexNoise } from '../utils/noise/SimplexNoise.js';
import { fbm2, ridged2 } from '../utils/noise/FractalNoise.js';
import { clamp, smoothstep, splineEval } from '../utils/MathUtils.js';
import { deriveSeed } from '../utils/Random.js';
import { fieldOffset } from './NoiseOffsets.js';
import { MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT, SEA_LEVEL } from '../config/Constants.js';

const CONTINENT_SPLINE = [[-1, 30], [-0.6, 42], [-0.3, 54], [-0.08, 60], [0.05, 65], [0.3, 72], [0.6, 82], [1, 96]];
const MOUNTAIN_AMPLITUDE = 62;
/**
 * Peaks layer tunables: ridged noise raised to `sharpen` (sharper ridges), scaled by `amplitude`, gated by
 * continentalness (cLo..cHi), low erosion (eLo..eHi, inverted) and the slow range field (rLo..rHi). Exported as
 * a plain object so the tuning script can explore values; the game never changes it.
 */
export const PEAKS = {
  amplitude: 205, sharpen: 1.4, scale: 380, rangeScale: 900,
  cLo: 0.1, cHi: 0.4, eLo: -0.22, eHi: 0.4, rLo: -0.15, rHi: 0.3, jag: 0.12,
};
/** Spawn flattening (was radius 260 with +0.9 erosion): a small gentle patch, the spawn search does the rest. */
export const SPAWN_BIAS_RADIUS = 48;
export const SPAWN_EROSION_BIAS = 0.4;
/** Valleys: |valley noise| below VALLEY_THRESHOLD is a valley (eased), below RIVER_THRESHOLD a river channel. */
export const VALLEY_SCALE = 520;
export const VALLEY_THRESHOLD = 0.14;
export const RIVER_THRESHOLD = 0.032;
export const VALLEY_FLOOR = SEA_LEVEL + 2;
export const RIVER_FLOOR = SEA_LEVEL - 3;

/** Column sample filled by TerrainShaper.sample(). */
export function createColumnSample() {
  return { height: 0, continent: 0, erosion: 0, peaks: 0, mountain: 0, peakHeight: 0, valley: 0, river: false, temperature: 0, humidity: 0 };
}

export class TerrainShaper {
  constructor(seed) {
    this.seed = seed;
    this.continentNoise = new SimplexNoise(deriveSeed(seed, 1));
    this.erosionNoise = new SimplexNoise(deriveSeed(seed, 2));
    this.peaksNoise = new SimplexNoise(deriveSeed(seed, 3));
    this.detailNoise = new SimplexNoise(deriveSeed(seed, 4));
    this.temperatureNoise = new SimplexNoise(deriveSeed(seed, 6));
    this.humidityNoise = new SimplexNoise(deriveSeed(seed, 7));
    this.peakLayerNoise = new SimplexNoise(deriveSeed(seed, 8));
    this.rangeNoise = new SimplexNoise(deriveSeed(seed, 9));
    this.valleyNoise = new SimplexNoise(deriveSeed(seed, 10));
    // Field origins: continent, erosion, peaks, detail, temperature, humidity, peak layer, range, valley (see NoiseOffsets.js).
    this.off = [1, 2, 3, 4, 6, 7, 8, 9, 10].map((i) => fieldOffset(seed, i));
    this.cache = new Map();
    this._scratch = createColumnSample();
  }

  /** Clear the per-chunk cache (call once per generated chunk). */
  resetCache() { this.cache.clear(); }

  /** Fill `out` with every terrain parameter for a world column. */
  sample(x, z, out) {
    const o = this.off;
    // Continentalness with a small bias toward land around the origin so spawn is on land.
    let c = fbm2(this.continentNoise, (x + o[0][0]) / 600, (z + o[0][2]) / 600, 4) * 1.7;
    const d2 = x * x + z * z;
    const spawnBias = Math.exp(-d2 / (SPAWN_BIAS_RADIUS * SPAWN_BIAS_RADIUS));
    c += 0.45 * spawnBias;
    c = clamp(c, -1, 1);
    // Mild extra erosion (flatness) right at the origin.
    const e = clamp(fbm2(this.erosionNoise, (x + o[1][0]) / 300, (z + o[1][2]) / 300, 3) * 1.6 + SPAWN_EROSION_BIAS * spawnBias, -1, 1);
    const pv = ridged2(this.peaksNoise, (x + o[2][0]) / 200, (z + o[2][2]) / 200, 3);
    const detail = fbm2(this.detailNoise, (x + o[3][0]) / 40, (z + o[3][2]) / 40, 2);

    const base = splineEval(CONTINENT_SPLINE, c);
    const ruggedness = 1 - smoothstep(-0.35, 0.15, e);
    const inland = smoothstep(0.05, 0.4, c);
    const mountain = pv * pv * MOUNTAIN_AMPLITUDE * ruggedness * inland;
    const hills = pv * 8 * inland * (0.4 + 0.6 * ruggedness);

    // Peaks layer: large-scale ridges, sharpened, only where the land is continental and unerod­ed, and only
    // inside "ranges" picked by a very slow field so plains stay more common than mountains.
    const P = PEAKS;
    const range = smoothstep(P.rLo, P.rHi, fbm2(this.rangeNoise, (x + o[7][0]) / P.rangeScale, (z + o[7][2]) / P.rangeScale, 2));
    const peakMask = smoothstep(P.cLo, P.cHi, c) * (1 - smoothstep(P.eLo, P.eHi, e)) * range;
    let peakHeight = 0;
    if (peakMask > 0.001) {
      const ridge = ridged2(this.peakLayerNoise, (x + o[6][0]) / P.scale, (z + o[6][2]) / P.scale, 3);
      const sharp = Math.pow(ridge, P.sharpen);
      peakHeight = sharp * P.amplitude * peakMask;
      // Jagged slopes and cliff steps: fine detail that grows with the peak height.
      peakHeight += fbm2(this.detailNoise, (x + o[3][0]) / 18 + 7.3, (z + o[3][2]) / 18 - 2.1, 2) * Math.min(14, peakHeight * P.jag);
    }
    let height = base + mountain + hills + peakHeight + detail * 4;

    // Valleys: where the valley field is near zero and the land is high enough to carve, pull the ground toward a
    // floor just above sea level (an eased, U-shaped profile); the deepest band drops below sea level and the
    // generator fills it with water — a river with sand / gravel beds that ends wherever the land rises again.
    let valley = 0, river = false;
    if (c > 0.08 && height > SEA_LEVEL + 4) {
      const v = Math.abs(fbm2(this.valleyNoise, (x + o[8][0]) / VALLEY_SCALE, (z + o[8][2]) / VALLEY_SCALE, 2));
      if (v < VALLEY_THRESHOLD) {
        const t = 1 - v / VALLEY_THRESHOLD;
        const ease = t * t * (3 - 2 * t);
        const landHigh = smoothstep(SEA_LEVEL + 6, SEA_LEVEL + 34, height);
        valley = ease * landHigh;
        let floor = VALLEY_FLOOR + (1 - ease) * 6;
        if (v < RIVER_THRESHOLD && landHigh > 0.6) {
          const rt = 1 - v / RIVER_THRESHOLD;
          floor = VALLEY_FLOOR + (RIVER_FLOOR - VALLEY_FLOOR) * Math.min(1, rt * 1.6);
          river = floor < SEA_LEVEL;
        }
        height += (floor - height) * valley;
      }
    }
    height = clamp(Math.round(height), MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT);

    let temperature = fbm2(this.temperatureNoise, (x + o[4][0]) / 800, (z + o[4][2]) / 800, 3) * 1.8;
    // Altitude cools the climate, but at most by 0.25 so a hot region's mountains stay short of snow.
    temperature -= Math.min(0.25, Math.max(0, height - 70) * 0.004);
    const humidity = clamp(fbm2(this.humidityNoise, (x + o[5][0]) / 800, (z + o[5][2]) / 800, 3) * 1.8, -1, 1);

    out.height = height;
    out.continent = c;
    out.erosion = e;
    out.peaks = pv;
    out.mountain = mountain + peakHeight;
    out.peakHeight = peakHeight;
    out.valley = valley;
    out.river = river;
    out.temperature = clamp(temperature, -1, 1);
    out.humidity = humidity;
    return out;
  }

  /** Cached height for a column (cache cleared per chunk). */
  heightAt(x, z) {
    const key = (x + 1048576) * 2097152 + (z + 1048576);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const h = this.sample(x, z, this._scratch).height;
    this.cache.set(key, h);
    return h;
  }
}
