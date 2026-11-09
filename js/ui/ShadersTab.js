// ShadersTab.js — the Shaders tab of the Settings screen: the master switch and the preset (Low / Medium / High / Ultra /
// Custom: changing any single option switches to Custom) as the first two rows, one row per SHADER_SCHEMA effect
// (disabled while shaders are off, and while the setting a row `needs` is off), then the live FPS line (refreshed four
// times a second while the tab is on screen) and the note. Everything is a setting (saved locally, applied live by
// ShaderPipeline.apply()).

import { SHADER_SCHEMA, SHADER_PRESETS } from '../config/DefaultSettings.js';
import { SettingRow } from './SettingRow.js';

const PRESET_NAMES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']];
const PRESET_CYCLE = ['low', 'medium', 'high', 'ultra']; // the button cycles the real presets; Custom only appears by editing

export class ShadersTab {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {HTMLElement} list  the tab's scrolling list
   * @param {() => boolean} visible  whether the tab is on screen (the FPS line only updates then)
   * @param {() => boolean} open  whether the Settings screen is open (the rows follow setting changes only then)
   */
  constructor(game, list, visible, open) {
    this.game = game;
    this.settings = game.settings;
    this.visible = visible;
    this.open = open;
    /** shader setting key → SettingRow (the SHADER_SCHEMA rows; the master switch and the preset are separate) */
    this.controls = new Map();
    this.applyingPreset = false;
    this.fpsTimer = 0;
    this.masterRow = new SettingRow(game, { key: 'shadersOn', label: 'Shaders', type: 'toggle', hint: 'Off is exactly the plain frame; shaders never change the game itself.' });
    this.presetRow = new SettingRow(game, { key: 'shaderPreset', label: 'Preset', type: 'select', options: PRESET_NAMES, cycle: PRESET_CYCLE }, (name) => this.applyPresetByName(name));
    list.append(this.masterRow.row, this.presetRow.row);
    for (const schema of SHADER_SCHEMA) {
      const row = new SettingRow(game, schema);
      this.controls.set(schema.key, row);
      list.appendChild(row.row);
    }
    const footer = document.createElement('div');
    footer.className = 'shaders-footer';
    this.fpsEl = document.createElement('span');
    this.fpsEl.id = 'shaders-fps'; this.fpsEl.className = 'shaders-fps'; this.fpsEl.textContent = '0 fps';
    const note = document.createElement('span');
    note.className = 'shaders-note'; note.textContent = 'Low runs on integrated graphics; shaders never change the game itself.';
    footer.append(this.fpsEl, note);
    list.appendChild(footer);
    game.events.on('settings:changed', (key) => {
      // Editing any single shader option makes the preset Custom (showFps also starts with "sh" but is not one).
      if (key.startsWith('sh') && key !== 'shaderPreset' && key !== 'shadersOn' && key !== 'showFps' && !this.applyingPreset) this.settings.set('shaderPreset', 'custom');
      if (this.open()) this.refresh();
    });
    this.refresh();
  }

  /** Apply a named preset's individual options and remember the name. */
  applyPresetByName(name) {
    const values = SHADER_PRESETS[name];
    if (!values) return;
    this.applyingPreset = true;
    try { this.settings.applyPreset(values); this.settings.set('shaderPreset', name); } finally { this.applyingPreset = false; }
    this.refresh();
  }

  refresh() {
    const on = !!this.settings.get('shadersOn');
    this.masterRow.refresh();
    this.presetRow.refresh();
    this.presetRow.setEnabled(on, false);
    for (const row of this.controls.values()) {
      row.refresh();
      row.setEnabled(on && !(row.schema.needs && !this.settings.get(row.schema.needs)), !on);
    }
    this._updateFps();
  }

  _updateFps() {
    if (!this.visible()) return;
    this.fpsEl.textContent = `${this.game.loop.fps} fps${this.game.state.inWorld ? '' : ' (menu)'}`;
  }

  /** Called from SettingsMenu.update while the tab is on screen: the FPS readout refreshes four times a second. */
  update(dt) {
    this.fpsTimer -= dt;
    if (this.fpsTimer <= 0) { this.fpsTimer = 0.25; this._updateFps(); }
  }
}
