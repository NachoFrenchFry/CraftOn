// LightUniforms.js — the Brightness option as live values (Update #10): two shader uniforms shared by every lit
// material (chunk materials with shaders off, the shader pipeline's lit materials) and the matching JS curve
// for everything coloured on the CPU (mobs, players, dropped items, particles, the first-person hand).
import { brightnessParams, lightCurve, lightColor as lightColorWith, BRIGHTNESS_DEFAULT } from '../world/lighting/LightCurve.js';

export const LIGHT_UNIFORMS = { uMinBright: { value: brightnessParams(BRIGHTNESS_DEFAULT).minBrightness }, uGamma: { value: 1 } };
export let lightParams = brightnessParams(BRIGHTNESS_DEFAULT);

/** Apply a Brightness setting (0..100) to the uniforms and the CPU curve. */
export function applyBrightness(setting) {
  lightParams = brightnessParams(setting);
  LIGHT_UNIFORMS.uMinBright.value = lightParams.minBrightness;
  LIGHT_UNIFORMS.uGamma.value = lightParams.gamma;
}

/** Brightness factor (0..1) for a sky light level 0..15 under the current Brightness setting. */
export function lightFactor(level) { return lightCurve(level, lightParams); }

/** [r, g, b] factors for a cell's sky and block light (the block channel warm-tinted, Update #11), under the current setting. */
export function lightColor(sky, block, out = [0, 0, 0]) { return lightColorWith(sky, block, lightParams, out); }

// A "light" handed to models is either a plain factor (number) or an [r, g, b] array; these helpers take both.
export function sameLight(a, b) {
  if (b === undefined || b === null) return false;
  if (typeof a === 'number') return typeof b === 'number' && Math.abs(a - b) < 0.003;
  return typeof b !== 'number' && Math.abs(a[0] - b[0]) < 0.003 && Math.abs(a[1] - b[1]) < 0.003 && Math.abs(a[2] - b[2]) < 0.003;
}
export function copyLight(a, into) {
  if (typeof a === 'number') return a;
  if (!into || typeof into === 'number') into = [0, 0, 0];
  into[0] = a[0]; into[1] = a[1]; into[2] = a[2];
  return into;
}
export function multiplyLight(color, light) {
  if (typeof light === 'number') color.multiplyScalar(light); else { color.r *= light[0]; color.g *= light[1]; color.b *= light[2]; }
  return color;
}
export function applyLight(color, light) {
  if (typeof light === 'number') color.setScalar(light); else color.setRGB(light[0], light[1], light[2]);
  return color;
}
