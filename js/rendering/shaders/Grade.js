// Grade.js — the game's one colour grade ("tone mapping & color"), always on for everyone: a slightly warmer, richer tint,
// a touch more saturation, then filmic ACES — blended with the original colour by GRADE_STRENGTH (Nov 14 2026: 0.6, so the
// picture is 60 % graded and 40 % original; one number to tune). The same math lives in two places that must match to the
// pixel: GRADE_GLSL is installed as Three's CustomToneMapping (Renderer.js replaces the stub in `tonemapping_pars_fragment`
// before any material compiles), so every material drawn straight to the canvas grades itself through
// `#include <tonemapping_fragment>`; the post chain's grade pass (PostFX.js) applies the identical function when a frame has
// to go through the EffectComposer (bloom, god rays, the underwater wobble), because Three never tone-maps while drawing into
// a render target. gradeColor() is the JavaScript twin for the fog colour: Three mixes the fog in AFTER tone mapping and the
// sRGB encode, so the direct path hands it the graded, encoded colour and distant terrain fades to the same colour as the
// graded sky. Nothing else may copy this math.
import * as THREE from 'three';

/** How much of the grade shows: 0 = the original colours, 1 = the full look. The GLSL below is written from this number. */
export const GRADE_STRENGTH = 0.6;

/** The grade body as GLSL: `vec3 craftonGrade(vec3 c)` — the full grade blended with the clamped original by GRADE_STRENGTH. */
export const GRADE_GLSL = `
const float CRAFTON_GRADE_STRENGTH = ${GRADE_STRENGTH.toFixed(4)};
vec3 craftonAces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 craftonGrade(vec3 c) {
  vec3 x = c * vec3(1.06, 1.0, 0.94) * 1.08; // slightly warmer, richer
  float l = dot(x, vec3(0.3, 0.59, 0.11));
  x = mix(vec3(l), x, 1.12);                 // a touch more saturation
  return mix(clamp(c, 0.0, 1.0), craftonAces(x), CRAFTON_GRADE_STRENGTH);
}`;

/** Three's stub that GRADE_GLSL replaces in ShaderChunk.tonemapping_pars_fragment (r160). */
export const CUSTOM_TONE_MAPPING_STUB = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
export const CUSTOM_TONE_MAPPING_GLSL = `${GRADE_GLSL}\nvec3 CustomToneMapping( vec3 color ) { return craftonGrade( color ); }`;

function aces(x) { return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))); }
function toSRGB(c) { return c <= 0.0031308 ? c * 12.92 : Math.pow(c, 1 / 2.4) * 1.055 - 0.055; }
function clamp01(c) { return Math.min(1, Math.max(0, c)); }

/**
 * The grade in JavaScript at any strength, followed by the sRGB encode the canvas gets: the colour a graded fragment ends up
 * as on screen. `color` is the raw working-space (linear) colour Three would hand the shader; the blend with the clamped
 * original happens in linear space, before the encode, exactly as in the GLSL. Writes into `out` (a THREE.Color) and returns
 * it. The tests compare strength 0 (ungraded), 1 (the full look) and GRADE_STRENGTH against the pixels on screen.
 */
export function gradeColorAt(color, strength, out = new THREE.Color()) {
  const r0 = clamp01(color.r), g0 = clamp01(color.g), b0 = clamp01(color.b);
  let r = color.r * 1.06 * 1.08, g = color.g * 1.0 * 1.08, b = color.b * 0.94 * 1.08;
  const l = r * 0.3 + g * 0.59 + b * 0.11;
  r = l + (r - l) * 1.12; g = l + (g - l) * 1.12; b = l + (b - l) * 1.12;
  return out.setRGB(toSRGB(r0 + (aces(r) - r0) * strength), toSRGB(g0 + (aces(g) - g0) * strength), toSRGB(b0 + (aces(b) - b0) * strength));
}

/** The grade as the game applies it (GRADE_STRENGTH), encoded for the screen — the fog colour on the direct path. */
export function gradeColor(color, out = new THREE.Color()) { return gradeColorAt(color, GRADE_STRENGTH, out); }
