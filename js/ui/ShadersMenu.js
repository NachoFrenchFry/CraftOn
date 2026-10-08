// ShadersMenu.js — Options → Shaders… (Update #9 §4): the master switch, the preset (Low / Medium / High / Ultra /
// Custom: changing any single option switches to Custom), one row per effect, the live FPS while the screen is
// open, and Done. Everything is a setting (saved locally, applied live by ShaderPipeline.apply()).
import { SHADER_SCHEMA, SHADER_PRESETS } from '../config/DefaultSettings.js';

const PRESET_NAMES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']];

export class ShadersMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.settings = game.settings;
    this.root = document.getElementById('shaders-menu');
    this.list = document.getElementById('shaders-list');
    this.masterButton = document.getElementById('btn-shaders-master');
    this.presetButton = document.getElementById('btn-shaders-preset');
    this.fpsEl = document.getElementById('shaders-fps');
    this.onDone = null;
    this.controls = new Map();
    this.applyingPreset = false;
    this.fpsTimer = 0;
    this._build();
    this.masterButton.addEventListener('click', () => { game.audio.playUI('click'); this.settings.set('shadersOn', !this.settings.get('shadersOn')); this.refresh(); });
    this.presetButton.addEventListener('click', () => {
      game.audio.playUI('click');
      const i = PRESET_NAMES.findIndex(([k]) => k === this.settings.get('shaderPreset'));
      const next = PRESET_NAMES[(i + 1) % (PRESET_NAMES.length - 1)][0]; // cycles Low → Medium → High → Ultra (Custom only appears by editing)
      this.applyPresetByName(next);
    });
    document.getElementById('btn-shaders-done').addEventListener('click', () => { game.audio.playUI('click'); this.close(); });
    game.events.on('settings:changed', (key) => {
      if (key.startsWith('sh') && key !== 'shaderPreset' && key !== 'shadersOn' && !this.applyingPreset) this.settings.set('shaderPreset', 'custom');
      if (this.isOpen) this.refresh();
    });
  }

  /** Apply a named preset's individual options and remember the name. */
  applyPresetByName(name) {
    const values = SHADER_PRESETS[name];
    if (!values) return;
    this.applyingPreset = true;
    try { this.settings.applyPreset(values); this.settings.set('shaderPreset', name); } finally { this.applyingPreset = false; }
    this.refresh();
  }

  _format(schema, value) {
    if (schema.type === 'toggle') return value ? 'ON' : 'OFF';
    if (schema.type === 'select') { const o = schema.options.find((x) => x[0] === value); return o ? o[1] : String(value); }
    return `${value}${schema.unit || ''}`;
  }

  _build() {
    for (const schema of SHADER_SCHEMA) {
      const row = document.createElement('div');
      row.className = 'option-row';
      const label = document.createElement('label');
      const name = document.createElement('span'); name.textContent = schema.label;
      const value = document.createElement('span'); value.className = 'value';
      label.append(name, value);
      row.appendChild(label);
      let control;
      if (schema.type === 'range') {
        control = document.createElement('input'); control.type = 'range';
        control.min = schema.min; control.max = schema.max; control.step = schema.step;
        control.addEventListener('input', () => { const v = parseFloat(control.value); this.settings.set(schema.key, v); value.textContent = this._format(schema, v); });
        control.addEventListener('change', () => this.game.audio.playUI('click', 0.4));
      } else {
        control = document.createElement('button'); control.className = 'mc-button toggle';
        control.addEventListener('click', () => {
          let next;
          if (schema.type === 'toggle') next = !this.settings.get(schema.key);
          else { const opts = schema.options; const i = opts.findIndex((o) => o[0] === this.settings.get(schema.key)); next = opts[(i + 1) % opts.length][0]; }
          this.settings.set(schema.key, next);
          control.textContent = this._format(schema, next);
          this.game.audio.playUI('click');
        });
      }
      row.appendChild(control);
      this.list.appendChild(row);
      this.controls.set(schema.key, { schema, control, value, row });
    }
  }

  refresh() {
    const on = !!this.settings.get('shadersOn');
    this.masterButton.textContent = `Shaders: ${on ? 'ON' : 'OFF'}`;
    const preset = this.settings.get('shaderPreset');
    const pn = PRESET_NAMES.find(([k]) => k === preset);
    this.presetButton.textContent = `Preset: ${pn ? pn[1] : 'Custom'}`;
    this.presetButton.disabled = !on;
    for (const { schema, control, value, row } of this.controls.values()) {
      const v = this.settings.get(schema.key);
      if (schema.type === 'range') { control.value = v; value.textContent = this._format(schema, v); }
      else { control.textContent = this._format(schema, v); value.textContent = ''; }
      control.disabled = !on || (schema.needs && !this.settings.get(schema.needs));
      row.classList.toggle('inactive', !on);
    }
    this._updateFps(true);
  }

  _updateFps(force = false) {
    if (!this.isOpen) return;
    this.fpsEl.textContent = `${this.game.loop.fps} fps${this.game.state.inWorld ? '' : ' (menu)'}`;
    void force;
  }

  /** Called from UIManager.update while open: the FPS readout refreshes four times a second. */
  update(dt) {
    if (!this.isOpen) return;
    this.fpsTimer -= dt;
    if (this.fpsTimer <= 0) { this.fpsTimer = 0.25; this._updateFps(); }
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  open(onDone) { this.onDone = onDone; this.refresh(); this.root.classList.remove('hidden'); }

  close() {
    this.root.classList.add('hidden');
    const cb = this.onDone; this.onDone = null;
    if (cb) cb();
  }
}
