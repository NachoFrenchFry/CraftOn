// OptionsMenu.js — sliders/toggles generated from SETTING_SCHEMA, bound live to Settings.

import { SETTING_SCHEMA, SETTING_SECTIONS, PERFORMANCE_MODE } from '../config/DefaultSettings.js';

export class OptionsMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.settings = game.settings;
    this.root = document.getElementById('options-menu');
    this.list = document.getElementById('options-list');
    this.onDone = null;
    this.controls = new Map();
    this._build();
    document.getElementById('btn-options-done').addEventListener('click', () => { game.audio.playUI('click'); this.close(); });
    document.getElementById('btn-options-controls').addEventListener('click', () => {
      game.audio.playUI('click');
      this.root.classList.add('hidden');
      game.ui.controls.open(() => this.root.classList.remove('hidden'));
    });
    document.getElementById('btn-options-shaders').addEventListener('click', () => {
      game.audio.playUI('click');
      if (!game.ui.shaders) return;
      this.root.classList.add('hidden');
      game.ui.shaders.open(() => this.root.classList.remove('hidden'));
    });
  }

  /** The Performance mode preset (Update #9 §7): half render scale, short distances, fast leaves, no AO, no shaders. */
  applyPerformanceMode() {
    this.settings.applyPreset(PERFORMANCE_MODE);
    this.refresh();
    this.game.ui.hud.showToast('Performance mode applied', false);
  }

  _format(schema, value) {
    if (schema.percent) return `${Math.round(value * 100)}%`;
    if (schema.type === 'toggle') return value ? 'ON' : 'OFF';
    if (schema.type === 'select') { const o = schema.options.find((x) => x[0] === value); return o ? o[1] : String(value); }
    return `${schema.step < 1 ? value.toFixed(2) : value}${schema.unit || ''}`;
  }

  _build() {
    for (const [section, title] of SETTING_SECTIONS) {
      const heading = document.createElement('div');
      heading.className = 'options-section';
      heading.textContent = title;
      this.list.appendChild(heading);
      for (const schema of SETTING_SCHEMA) if ((schema.section || 'general') === section) this._buildRow(schema);
      if (section === 'performance') {
        const row = document.createElement('div');
        row.className = 'option-row wide';
        const b = document.createElement('button');
        b.id = 'btn-performance-mode'; b.className = 'mc-button'; b.textContent = 'Performance mode';
        b.title = 'Render scale 50%, render distance 4, simulation distance 3, decreased particles, fast leaves, AO off, shaders off';
        b.addEventListener('click', () => { this.game.audio.playUI('click'); this.applyPerformanceMode(); });
        row.appendChild(b);
        this.list.appendChild(row);
      }
    }
  }

  _buildRow(schema) {
    {
      const row = document.createElement('div');
      row.className = 'option-row';
      const label = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = schema.label;
      const value = document.createElement('span');
      value.className = 'value';
      label.append(name, value);
      row.appendChild(label);
      let control;
      if (schema.type === 'range') {
        control = document.createElement('input');
        control.type = 'range';
        control.min = schema.min; control.max = schema.max; control.step = schema.step;
        control.addEventListener('input', () => {
          const v = parseFloat(control.value);
          this.settings.set(schema.key, v);
          value.textContent = this._format(schema, v);
        });
        control.addEventListener('change', () => this.game.audio.playUI('click', 0.4));
      } else if (schema.type === 'toggle') {
        control = document.createElement('button');
        control.className = 'mc-button toggle';
        control.addEventListener('click', () => {
          const v = !this.settings.get(schema.key);
          this.settings.set(schema.key, v);
          control.textContent = this._format(schema, v);
          value.textContent = '';
          this.game.audio.playUI('click');
        });
      } else {
        control = document.createElement('button');
        control.className = 'mc-button toggle';
        control.addEventListener('click', () => {
          const opts = schema.options;
          const i = opts.findIndex((o) => o[0] === this.settings.get(schema.key));
          const next = opts[(i + 1) % opts.length][0];
          this.settings.set(schema.key, next);
          control.textContent = this._format(schema, next);
          this.game.audio.playUI('click');
        });
      }
      row.appendChild(control);
      this.list.appendChild(row);
      this.controls.set(schema.key, { schema, control, value });
    }
  }

  refresh() {
    for (const { schema, control, value } of this.controls.values()) {
      const v = this.settings.get(schema.key);
      if (schema.type === 'range') { control.value = v; value.textContent = this._format(schema, v); }
      else { control.textContent = this._format(schema, v); value.textContent = ''; }
    }
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  open(onDone) {
    this.onDone = onDone;
    this.refresh();
    this.root.classList.remove('hidden');
  }

  close() {
    this.root.classList.add('hidden');
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }
}
