// LightUniforms.js — the Brightness option as live values (Update #10): two shader uniforms shared by every lit
// material (chunk materials with shaders off, the shader pipeline's lit materials) and the matching JS curve
// for everything coloured on the CPU (mobs, players, dropped items, particles, the first-person hand).
import { brightnessParams, lightCurve, BRIGHTNESS_DEFAULT } from '../world/lighting/LightCurve.js';

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
