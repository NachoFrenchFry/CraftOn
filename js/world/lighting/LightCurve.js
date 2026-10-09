// LightCurve.js — the one brightness curve (Update #10) shared by the mesher-fed chunk materials, the shader
// pipeline, mobs, players, dropped items, particles and the first-person hand. Minecraft-like:
//   l = level / 15;  curve = l / (4 − 3 l);  curve = mix(minBrightness, 1, curve ^ gamma)
// `minBrightness` and `gamma` come from the Brightness option (Moody 0 % … Bright 100 %, default 50 %):
// about 0.04 at Moody, 0.12 at 50 %, 0.28 at Bright, with a gentle gamma lift above 50 %. Pure.

export const BRIGHTNESS_DEFAULT = 50;

/** { minBrightness, gamma } for a Brightness setting 0..100. */
export function brightnessParams(setting) {
  const b = Math.min(1, Math.max(0, (Number(setting) || 0) / 100));
  const minBrightness = b <= 0.5 ? 0.04 + (0.12 - 0.04) * (b / 0.5) : 0.12 + (0.28 - 0.12) * ((b - 0.5) / 0.5);
  const gamma = b <= 0.5 ? 1 : 1 - 0.35 * ((b - 0.5) / 0.5);
  return { minBrightness, gamma };
}

/** Brightness factor (0..1) of a light level 0..15 (fractions allowed: smoothed corner light). */
export function lightCurve(level, params = brightnessParams(BRIGHTNESS_DEFAULT)) {
  const l = Math.min(1, Math.max(0, level / 15));
  let c = l / (4 - 3 * l);
  if (params.gamma !== 1) c = Math.pow(c, params.gamma);
  return params.minBrightness + (1 - params.minBrightness) * c;
}

/**
 * Block light's warm tint (Update #11): final colour = max(curve(sky), curve(block) × tint). The multiplier works in
 * linear light, so these are the linear values of about #FFD9A0 (sRGB 1 / 0.85 / 0.63 → linear 1 / 0.74 / 0.45);
 * after the renderer's sRGB output a torch-lit stone wall reads as that colour.
 */
export const BLOCK_LIGHT_TINT = Object.freeze([1, 0.74, 0.45]);

/** Lit colour factors of a cell from both channels (0–15 each, fractions allowed). */
export function lightColor(sky, block, params = brightnessParams(BRIGHTNESS_DEFAULT), out = [0, 0, 0]) {
  const s = lightCurve(sky, params), b = lightCurve(block, params);
  out[0] = Math.max(s, b * BLOCK_LIGHT_TINT[0]); out[1] = Math.max(s, b * BLOCK_LIGHT_TINT[1]); out[2] = Math.max(s, b * BLOCK_LIGHT_TINT[2]);
  return out;
}

/** The same curve in GLSL (plus the two-channel combine); the two uniforms are shared by every lit material (LightUniforms.js). */
export const LIGHT_CURVE_GLSL = `
uniform float uMinBright;
uniform float uGamma;
const vec3 craftonWarm = vec3(1.0, 0.74, 0.45); // linear-space #FFD9A0
float craftonLightCurve(float l) {
  l = clamp(l, 0.0, 1.0);
  float c = l / (4.0 - 3.0 * l);
  c = pow(c, uGamma);
  return mix(uMinBright, 1.0, c);
}
vec3 craftonLightRGB(vec2 l) {
  return max(vec3(craftonLightCurve(l.x)), craftonLightCurve(l.y) * craftonWarm);
}`;
