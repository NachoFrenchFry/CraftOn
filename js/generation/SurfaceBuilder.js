// SurfaceBuilder.js — top/filler layers per biome, steep-slope stone, underwater floors (oceans and
// river beds), snow caps on gentle high slopes, bare stone / gravel on steep faces and stony summits with
// snow patches (Update #8), and the jagged bedrock floor. Worker-safe.

import { SEA_LEVEL, WORLD_HEIGHT, STONY_PEAK_Y } from '../config/Constants.js';
import { BlockIds as B } from '../blocks/BlockIds.js';
import { BIOMES, BiomeIds, SNOW_LINE } from './Biomes.js';
import { hash3 } from '../utils/MathUtils.js';
import { fieldOffset } from './NoiseOffsets.js';
import { SimplexNoise } from '../utils/noise/SimplexNoise.js';
import { deriveSeed } from '../utils/Random.js';

export const MARGIN = 2;
export const HM_SIZE = 16 + MARGIN * 2;

export const STEEP_SLOPE = 3;

export class SurfaceBuilder {
  constructor(seed) {
    this.seed = seed;
    this.patchNoise = new SimplexNoise(deriveSeed(seed, 11));
    this.patchOff = fieldOffset(seed, 11);
  }

  /**
   * @param {Uint8Array} blocks chunk block array
   * @param {Int16Array} heights HM_SIZE² heightmap with margin
   * @param {Uint8Array} biomes HM_SIZE² biome ids with margin
   */
  build(blocks, heights, biomes, cx, cz) {
    const wx0 = cx * 16, wz0 = cz * 16;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const hi = (lx + MARGIN) + (lz + MARGIN) * HM_SIZE;
        const h = heights[hi];
        const biome = BIOMES[biomes[hi]];
        const colBase = lx + (lz << 4);
        const wx = wx0 + lx, wz = wz0 + lz;
        const colHash = hash3(this.seed, wx, wz);

        // Stone column.
        for (let y = 1; y <= h; y++) blocks[colBase + (y << 8)] = B.STONE;

        // Steepness from the four neighbours.
        const dh = Math.max(
          Math.abs(h - heights[hi - 1]), Math.abs(h - heights[hi + 1]),
          Math.abs(h - heights[hi - HM_SIZE]), Math.abs(h - heights[hi + HM_SIZE]),
        );
        const steep = dh >= STEEP_SLOPE;
        const fillerDepth = biome.fillerDepth + (colHash & 1);

        let top = biome.top, filler = biome.filler;
        if (h < SEA_LEVEL) {
          // Underwater floor (oceans and river beds): sand with gravel / clay patches.
          const n = this.patchNoise.noise2D((wx + this.patchOff[0]) / 18, (wz + this.patchOff[2]) / 18);
          top = n > 0.45 ? B.GRAVEL : n < -0.5 ? B.CLAY : B.SAND;
          filler = top === B.CLAY ? B.CLAY : B.SAND;
        } else if (biome.id === BiomeIds.MOUNTAINS && h >= STONY_PEAK_Y) {
          // Stony peaks: bare rock summits with gravel and snow patches.
          const r = (colHash >> 2) & 7;
          top = r < 3 ? B.SNOW : r === 3 ? B.GRAVEL : B.STONE; filler = B.STONE;
        } else if (biome.id === BiomeIds.MOUNTAINS && h >= SNOW_LINE + ((colHash >> 3) & 3)) {
          // Snowy slopes: snow on gentle ground, exposed rock on steep faces.
          top = steep ? (((colHash >> 5) & 7) === 0 ? B.GRAVEL : B.STONE) : B.SNOW; filler = B.STONE;
        } else if (steep && (biome.id === BiomeIds.MOUNTAINS || biome.top === B.GRASS || biome.top === B.SNOWY_GRASS)) {
          // Exposed rock on cliffs, occasionally gravel.
          top = ((colHash >> 5) & 7) === 0 ? B.GRAVEL : B.STONE;
          filler = B.STONE;
        }

        if (top !== B.STONE || filler !== B.STONE) {
          blocks[colBase + (h << 8)] = top;
          for (let d = 1; d <= fillerDepth && h - d > 0; d++) blocks[colBase + ((h - d) << 8)] = filler;
          if (biome.subFiller) {
            for (let d = fillerDepth + 1; d <= fillerDepth + biome.subFillerDepth && h - d > 0; d++) {
              blocks[colBase + ((h - d) << 8)] = biome.subFiller;
            }
          }
        }

        // Bedrock: solid at y = 0, thinning out up to y = 4.
        blocks[colBase] = B.BEDROCK;
        for (let y = 1; y <= 4; y++) {
          const r = (hash3(this.seed ^ 0xbed, wx, wz * 8 + y) & 255) / 256;
          if (r < (5 - y) / 5) blocks[colBase + (y << 8)] = B.BEDROCK;
        }
      }
    }
  }
}
