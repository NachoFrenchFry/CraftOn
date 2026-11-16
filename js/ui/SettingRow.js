// SettingRow.js — the one row builder of the Settings screen. A row is full width: the label on the left with the hint or
// warning in small gray under it, the control on the right — a slider with its value in yellow before it, an ON / OFF
// button, or a cycling select button that shows the value — bound live to Settings. Every tab (Video, Performance,
// Audio, Shaders and the Controls tab's option rows) builds its rows here, and so does the Create World form (a 'text' row
// for the name and seed, its values in a plain object through the `store` parameter); the row's control carries the id
// `setting-<key>` (or `<schema.idPrefix>-<key>`) for the headless tests.

/** The text shown for a value: a percentage, ON / OFF, the select label, "Off" below `offBelow`, or value + unit. */
export function formatSetting(schema, value) {
  if (schema.percent) return `${Math.round(value * 100)}%`;
  if (schema.type === 'toggle') return value ? 'ON' : 'OFF';
  if (schema.type === 'select') { const o = schema.options.find((x) => x[0] === value); return o ? o[1] : String(value); }
  if (schema.offBelow !== undefined && value < schema.offBelow) return 'Off';
  return `${schema.step < 1 ? value.toFixed(2) : value}${schema.unit || ''}`;
}

export class SettingRow {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {object} schema  a SETTING_SCHEMA / SHADER_SCHEMA entry: key, label, type ('range' | 'toggle' | 'select'),
   *   min / max / step / unit / percent, options ([value, label] pairs; `cycle` limits what the button cycles through),
   *   hint, warn(value) → text | null
   * @param {((value: any) => void)|null} [set]  how a new value is stored; the default is settings.set(key, value)
   *   (the Shaders preset row applies a whole preset instead)
   * @param {{ get(key: string): any, set(key: string, value: any): void }|null} [store]  where the value lives when it is not a
   *   game setting (the Create World form keeps its rows in a plain object); the default is game.settings
   */
  constructor(game, schema, set = null, store = null) {
    this.game = game;
    this.settings = store || game.settings;
    this.schema = schema;
    this.set = set || ((v) => this.settings.set(schema.key, v));
    const row = document.createElement('div');
    row.className = 'option-row';
    row.dataset.key = schema.key;
    const text = document.createElement('div');
    text.className = 'option-text';
    const label = document.createElement('span');
    label.className = 'option-label';
    label.textContent = schema.label;
    text.appendChild(label);
    if (schema.hint) { const h = document.createElement('div'); h.className = 'option-hint'; h.textContent = schema.hint; text.appendChild(h); }
    const holder = document.createElement('div');
    holder.className = 'option-control';
    const value = document.createElement('span');
    value.className = 'value';
    let control;
    if (schema.type === 'range') {
      control = document.createElement('input');
      control.type = 'range';
      control.min = schema.min; control.max = schema.max; control.step = schema.step;
      control.addEventListener('input', () => this._apply(parseFloat(control.value)));
      control.addEventListener('change', () => game.audio.playUI('click', 0.4));
      holder.append(value, control);
    } else if (schema.type === 'text') {
      // A text box (the Create World form's name and seed): the text is stored as it changes; Enter submits through schema.onEnter.
      control = document.createElement('input');
      control.type = 'text';
      control.className = 'option-input';
      if (schema.maxLength) control.maxLength = schema.maxLength;
      if (schema.placeholder) control.placeholder = schema.placeholder;
      control.autocomplete = 'off'; control.spellcheck = false;
      control.addEventListener('input', () => this._apply(control.value));
      control.addEventListener('focus', () => { game.input.textInputActive = true; });
      control.addEventListener('blur', () => { game.input.textInputActive = false; });
      control.addEventListener('keydown', (e) => { if (e.key === 'Enter' && schema.onEnter) schema.onEnter(); e.stopPropagation(); });
      holder.appendChild(control);
    } else {
      control = document.createElement('button');
      control.type = 'button';
      control.className = 'mc-button ' + (schema.type === 'toggle' ? 'toggle' : 'select');
      control.addEventListener('click', () => {
        let next;
        if (schema.type === 'toggle') next = !this.settings.get(schema.key);
        else {
          const cycle = schema.cycle || schema.options.map((o) => o[0]);
          next = cycle[(cycle.indexOf(this.settings.get(schema.key)) + 1) % cycle.length];
        }
        this._apply(next);
        game.audio.playUI('click');
      });
      holder.appendChild(control);
    }
    control.id = `${schema.idPrefix || 'setting'}-${schema.key}`; // the headless tests find controls by id (a form passes its own prefix)
    row.append(text, holder);
    this.row = row; this.text = text; this.value = value; this.control = control;
    this.refresh();
  }

  _apply(v) { this.set(v); this._show(v); }

  _show(v) {
    if (this.schema.type === 'range') { this.control.value = v; this.value.textContent = formatSetting(this.schema, v); }
    else if (this.schema.type === 'text') { const t = v == null ? '' : String(v); if (this.control.value !== t) this.control.value = t; } // never moves the caret while typing
    else this.control.textContent = formatSetting(this.schema, v);
    if (this.schema.warn) this.setWarn(this.schema.warn(v));
  }

  /** A warning line under the label (e.g. "High memory use" above 16 chunks), or none. */
  setWarn(text) {
    let el = this.text.querySelector('.option-warn');
    if (!text) { if (el) el.remove(); this.row.classList.remove('warn'); return; }
    if (!el) { el = document.createElement('div'); el.className = 'option-hint option-warn'; this.text.appendChild(el); }
    el.textContent = '⚠ ' + text;
    this.row.classList.add('warn');
  }

  /** A disabled control cannot be used; an inactive row is dimmed as a whole (the Shaders rows while shaders are off). */
  setEnabled(enabled, inactive = !enabled) {
    this.control.disabled = !enabled;
    this.row.classList.toggle('inactive', inactive);
  }

  /** Show the stored value (and the warning that goes with it). */
  refresh() { this._show(this.settings.get(this.schema.key)); }
}
