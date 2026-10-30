// DefaultSettings.js — default user options. Settings.js merges these with localStorage and ignores keys that
// no longer exist (the `clouds` toggle was removed; old saved settings still load). Later came
// the Performance section (render scale, FPS cap, simulation / entity distance, particles, leaves, chunk
// updates) and the client-only shader options (the Shaders screen).

export const DEFAULT_SETTINGS = Object.freeze({
  renderDistance: 8,      // chunks, 2..32 (above 16 the options screen warns about the computer and memory this needs)
  antialias: 'msaa4',     // 'off' | 'fxaa' | 'msaa2' | 'msaa4' (MSAA is set when the WebGL context is created: a reload applies it)
  fov: 70,                // degrees, 50..110
  mouseSensitivity: 0.5,  // 0.05..1.5
  crouchMode: 'hold',     // 'hold' | 'toggle' (Controls screen)
  invertY: false,
  masterVolume: 0.8,
  blocksVolume: 1.0,
  playerVolume: 1.0,
  ambientVolume: 0.6,
  uiVolume: 0.8,
  guiScale: 0,            // 0 = Auto, 1..4 fixed
  smoothLighting: true, // ambient occlusion + 4-corner smooth light
  brightness: 50,         // Moody 0 % … Bright 100 %: how bright light level 0 is (caves stay playable)
  viewBobbing: 50,        // intensity 0..100 % (0 = off); 50 % is the tuned default
  fovEffects: 100,        // 0..100 %: scales the sprint / speed / rocket FOV widening (0 = off)
  showFps: false,
  // ---- Performance ----
  renderScale: 0,         // 0.25 / 0.5 / 0.75 / 1 of the device resolution, or 0 = Auto (lowers itself under the FPS target; the default)
  hiDpi: false, // false caps the device pixel ratio at 1 (a 4K / Retina screen renders at its CSS size); true uses the full ratio
  maxFps: 0,              // 30 / 60 / 120, 0 = unlimited
  simulationDistance: 6,  // chunks 2..8: mobs, water flow and item entities only update this far from the player
  entityDistance: 100,    // % of the render distance beyond which mobs, dropped items and other players are hidden
  particles: 'all',       // 'all' | 'decreased' | 'minimal'
  fancyLeaves: false, // false = fast leaves: opaque, faces between leaf blocks culled (the default)
  chunkUpdates: 'normal', // 'low' | 'normal' | 'high': mesh uploads per frame
  // ---- Shaders, client-only ----
  shadersOn: false,
  shaderPreset: 'medium', // 'low' | 'medium' | 'high' | 'ultra' | 'custom'
  shShadows: true,
  shShadowQuality: 1024,  // shadow map size 1024 / 2048 / 4096
  shShadowDistance: 48,   // blocks 32..128
  shNearShadow: true,     // a second, near shadow cascade (sharp contact shadows); Low keeps one
  shLighting: true,
  shWater: true,
  shWaving: true,
  shBloom: false,
  shGodRays: false,
  shToneMap: true,
  shVignette: true,
  shUnderwater: true,
});

/** Sections of the Options screen, in order. */
export const SETTING_SECTIONS = Object.freeze([['general', 'Game'], ['audio', 'Audio'], ['performance', 'Performance']]);

/** Descriptions used by the options screen to build controls. */
export const SETTING_SCHEMA = [
  { key: 'renderDistance', label: 'Render Distance', type: 'range', min: 2, max: 32, step: 1, unit: ' chunks', section: 'general', warn: (v) => (v > 16 ? 'High render distances need a strong computer and lots of memory.' : null) },
  { key: 'fov', label: 'FOV', type: 'range', min: 50, max: 110, step: 1, unit: '°', section: 'general' },
  { key: 'fovEffects', label: 'FOV Effects (sprint / speed zoom)', type: 'range', min: 0, max: 100, step: 5, unit: '%', section: 'general' },
  { key: 'mouseSensitivity', label: 'Mouse Sensitivity', type: 'range', min: 0.05, max: 1.5, step: 0.05, unit: '', section: 'general' },
  { key: 'invertY', label: 'Invert Mouse Y', type: 'toggle', section: 'general' },
  { key: 'guiScale', label: 'GUI Scale', type: 'select', options: [[0, 'Auto'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], section: 'general' },
  { key: 'viewBobbing', label: 'View Bobbing', type: 'range', min: 0, max: 100, step: 5, unit: '%', section: 'general' },
  { key: 'brightness', label: 'Brightness (Moody → Bright)', type: 'range', min: 0, max: 100, step: 5, unit: '%', section: 'general' },
  { key: 'showFps', label: 'Show FPS', type: 'toggle', section: 'general' },
  { key: 'masterVolume', label: 'Master Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true, section: 'audio' },
  { key: 'blocksVolume', label: 'Blocks Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true, section: 'audio' },
  { key: 'playerVolume', label: 'Player Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true, section: 'audio' },
  { key: 'ambientVolume', label: 'Ambient Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true, section: 'audio' },
  { key: 'uiVolume', label: 'UI Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true, section: 'audio' },
  { key: 'renderScale', label: 'Render Scale', type: 'select', options: [[0.25, '25%'], [0.5, '50%'], [0.75, '75%'], [1, '100%'], [0, 'Auto']], section: 'performance' },
  { key: 'hiDpi', label: 'HiDPI Rendering', type: 'toggle', section: 'performance' },
  { key: 'maxFps', label: 'Max FPS', type: 'select', options: [[30, '30'], [60, '60'], [120, '120'], [0, 'Unlimited']], section: 'performance' },
  { key: 'simulationDistance', label: 'Simulation Distance', type: 'range', min: 2, max: 8, step: 1, unit: ' chunks', section: 'performance' },
  { key: 'entityDistance', label: 'Entity Distance', type: 'range', min: 50, max: 100, step: 10, unit: '%', section: 'performance' },
  { key: 'particles', label: 'Particles', type: 'select', options: [['all', 'All'], ['decreased', 'Decreased'], ['minimal', 'Minimal']], section: 'performance' },
  { key: 'fancyLeaves', label: 'Leaves', type: 'select', options: [[true, 'Fancy'], [false, 'Fast']], section: 'performance' },
  { key: 'smoothLighting', label: 'Smooth Lighting (AO)', type: 'toggle', section: 'performance' },
  { key: 'chunkUpdates', label: 'Chunk Updates per Frame', type: 'select', options: [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']], section: 'performance' },
  { key: 'antialias', label: 'Anti-aliasing', type: 'select', options: [['off', 'Off'], ['fxaa', 'FXAA'], ['msaa2', 'MSAA 2×'], ['msaa4', 'MSAA 4×']], section: 'performance', hint: 'MSAA smooths block edges only (pixel art stays crisp); FXAA works live but may soften textures slightly. MSAA changes apply after a reload; without MSAA support FXAA is used.', warn: (v) => (typeof globalThis !== 'undefined' && globalThis.__craftonMsaa !== undefined && (String(v).startsWith('msaa') ? 'on' : 'off') !== globalThis.__craftonMsaa ? 'Reload the page to apply this MSAA setting' : null) },
];

/** The Shaders screen rows; `shadersOn` and `shaderPreset` are the two controls above the list. */
export const SHADER_SCHEMA = [
  { key: 'shShadows', label: 'Shadows', type: 'toggle' },
  { key: 'shShadowQuality', label: 'Shadow quality', type: 'select', options: [[1024, '1024'], [2048, '2048'], [4096, '4096']], needs: 'shShadows' },
  { key: 'shShadowDistance', label: 'Shadow distance', type: 'range', min: 32, max: 128, step: 16, unit: ' blocks', needs: 'shShadows' },
  { key: 'shNearShadow', label: 'Sharp nearby shadows', type: 'toggle', needs: 'shShadows', hint: 'A second, higher-detail shadow map close to you. Sharper shadows on nearby blocks, players and mobs. Costs some performance.' },
  { key: 'shLighting', label: 'Lighting (sun + sky)', type: 'toggle' },
  { key: 'shWater', label: 'Fancy water', type: 'toggle' },
  { key: 'shWaving', label: 'Waving plants', type: 'toggle' },
  { key: 'shBloom', label: 'Bloom', type: 'toggle' },
  { key: 'shGodRays', label: 'God rays', type: 'toggle' },
  { key: 'shToneMap', label: 'Tone mapping & color', type: 'toggle' },
  { key: 'shVignette', label: 'Vignette', type: 'toggle' },
  { key: 'shUnderwater', label: 'Underwater effects', type: 'toggle' },
];

/** Presets: Low runs on integrated graphics (no shadows, no post), Ultra turns everything up. */
export const SHADER_PRESETS = Object.freeze({
  low: { shShadows: false, shShadowQuality: 1024, shShadowDistance: 32, shNearShadow: false, shLighting: true, shWater: false, shWaving: true, shBloom: false, shGodRays: false, shToneMap: true, shVignette: false, shUnderwater: false },
  medium: { shShadows: true, shShadowQuality: 1024, shShadowDistance: 48, shNearShadow: true, shLighting: true, shWater: true, shWaving: true, shBloom: false, shGodRays: false, shToneMap: true, shVignette: true, shUnderwater: true },
  high: { shShadows: true, shShadowQuality: 2048, shShadowDistance: 64, shNearShadow: true, shLighting: true, shWater: true, shWaving: true, shBloom: true, shGodRays: true, shToneMap: true, shVignette: true, shUnderwater: true },
  ultra: { shShadows: true, shShadowQuality: 4096, shShadowDistance: 96, shNearShadow: true, shLighting: true, shWater: true, shWaving: true, shBloom: true, shGodRays: true, shToneMap: true, shVignette: true, shUnderwater: true },
});

/** The "Performance mode" preset button. */
export const PERFORMANCE_MODE = Object.freeze({ renderScale: 0.5, renderDistance: 4, simulationDistance: 3, particles: 'decreased', fancyLeaves: false, smoothLighting: false, shadersOn: false, antialias: 'off' });

const RENDER_SCALES = [0.25, 0.5, 0.75, 1];
/** Snap values saved by older versions onto the current choices (render scale used to be a free slider). */
export function normalizeSetting(key, value) {
  if (key === 'renderScale' && value !== 0 && !RENDER_SCALES.includes(value)) {
    let best = 1; for (const s of RENDER_SCALES) if (Math.abs(s - value) < Math.abs(best - value)) best = s;
    return best;
  }
  return value;
}
