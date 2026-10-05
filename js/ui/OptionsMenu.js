// OptionsMenu.js — sliders/toggles generated from SETTING_SCHEMA, bound live to Settings.

import { SETTING_SCHEMA } from '../config/DefaultSettings.js';

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
  }

  _format(schema, value) {
    if (schema.percent) return `${Math.round(value * 100)}%`;
    if (schema.type === 'toggle') return value ? 'ON' : 'OFF';
    if (schema.type === 'select') { const o = schema.options.find((x) => x[0] === value); return o ? o[1] : String(value); }
    return `${schema.step < 1 ? value.toFixed(2) : value}${schema.unit || ''}`;
  }

  _build() {
    for (const schema of SETTING_SCHEMA) {
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
