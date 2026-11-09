// OptionsTab.js — the schema-driven rows of the Settings screen: for the Video, Performance and Audio tabs and the
// Controls tab's mouse / crouch rows, one SettingRow per SETTING_SCHEMA entry whose `section` is the tab, plus the
// Performance mode button at the end of the Performance tab. Rows are bound live to Settings and follow a setting changed
// from elsewhere while the screen is open; refresh() shows every stored value (when the screen opens, after a preset).

import { SETTING_SCHEMA, PERFORMANCE_MODE } from '../config/DefaultSettings.js';
import { SettingRow } from './SettingRow.js';

export class OptionsTab {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {() => boolean} open  whether the Settings screen is open (rows follow outside changes only then)
   */
  constructor(game, open) {
    this.game = game;
    this.settings = game.settings;
    /** setting key → SettingRow (every schema row of every tab) */
    this.controls = new Map();
    game.events.on('settings:changed', (key) => { const row = this.controls.get(key); if (row && open()) row.refresh(); });
  }

  /** Append the rows of one tab — every schema entry with `section === tabId`, in schema order — to its list. */
  build(tabId, list) {
    for (const schema of SETTING_SCHEMA) {
      if (schema.section !== tabId) continue;
      const row = new SettingRow(this.game, schema);
      this.controls.set(schema.key, row);
      list.appendChild(row.row);
    }
    if (tabId === 'performance') {
      const row = document.createElement('div');
      row.className = 'option-row wide';
      const b = document.createElement('button');
      b.id = 'btn-performance-mode'; b.type = 'button'; b.className = 'mc-button'; b.textContent = 'Performance mode';
      b.title = 'Render scale 50%, render distance 4, simulation distance 3, decreased particles, fast leaves, AO off, shaders off, anti-aliasing off';
      b.addEventListener('click', () => { this.game.audio.playUI('click'); this.applyPerformanceMode(); });
      row.appendChild(b);
      list.appendChild(row);
    }
  }

  /** The Performance mode preset: half render scale, short distances, fast leaves, no AO, no shaders. */
  applyPerformanceMode() {
    this.settings.applyPreset(PERFORMANCE_MODE);
    this.refresh();
    this.game.ui.hud.showToast('Performance mode applied', false);
  }

  refresh() { for (const row of this.controls.values()) row.refresh(); }
}
