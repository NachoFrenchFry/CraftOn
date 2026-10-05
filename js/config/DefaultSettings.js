// DefaultSettings.js — default user options. Settings.js merges these with localStorage and ignores keys that
// no longer exist (the `clouds` toggle was removed in Update #7; old saved settings still load).

export const DEFAULT_SETTINGS = Object.freeze({
  renderDistance: 8,      // chunks, 2..16
  fov: 70,                // degrees, 50..110
  mouseSensitivity: 0.5,  // 0.05..1.5
  invertY: false,
  masterVolume: 0.8,
  blocksVolume: 1.0,
  playerVolume: 1.0,
  ambientVolume: 0.6,
  uiVolume: 0.8,
  guiScale: 0,            // 0 = Auto, 1..4 fixed
  smoothLighting: true,   // ambient occlusion
  viewBobbing: 50,        // intensity 0..100 % (0 = off); 50 % is the tuned default
  showFps: false,
  renderScale: 1.0,       // 0.5..1 multiplier on device pixel ratio
});

/** Descriptions used by the options screen to build controls. */
export const SETTING_SCHEMA = [
  { key: 'renderDistance', label: 'Render Distance', type: 'range', min: 2, max: 16, step: 1, unit: ' chunks' },
  { key: 'fov', label: 'FOV', type: 'range', min: 50, max: 110, step: 1, unit: '°' },
  { key: 'mouseSensitivity', label: 'Mouse Sensitivity', type: 'range', min: 0.05, max: 1.5, step: 0.05, unit: '' },
  { key: 'invertY', label: 'Invert Mouse Y', type: 'toggle' },
  { key: 'guiScale', label: 'GUI Scale', type: 'select', options: [[0, 'Auto'], [1, '1'], [2, '2'], [3, '3'], [4, '4']] },
  { key: 'renderScale', label: 'Render Scale', type: 'range', min: 0.5, max: 1, step: 0.05, unit: 'x' },
  { key: 'masterVolume', label: 'Master Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true },
  { key: 'blocksVolume', label: 'Blocks Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true },
  { key: 'playerVolume', label: 'Player Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true },
  { key: 'ambientVolume', label: 'Ambient Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true },
  { key: 'uiVolume', label: 'UI Volume', type: 'range', min: 0, max: 1, step: 0.05, percent: true },
  { key: 'smoothLighting', label: 'Smooth Lighting (AO)', type: 'toggle' },
  { key: 'viewBobbing', label: 'View Bobbing', type: 'range', min: 0, max: 100, step: 5, unit: '%' },
  { key: 'showFps', label: 'Show FPS', type: 'toggle' },
];
