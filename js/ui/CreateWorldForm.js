// CreateWorldForm.js — the one Create World form (Nov 10 2026). Play → Create New World and Multiplayer → Host New Server →
// Create New World both build it (MainMenu / MultiplayerMenu); only their button differs ("Create" / "Create & Host"). A
// scrollable list of SettingRow rows in the Settings style — the label on the left with a gray hint under it, the control on
// the right — over a plain object of values (the rows and defaults are CREATE_WORLD_ROWS / WORLD_DEFAULTS in
// WorldSettings.js), plus the Superflat layer editor right under the World type row, shown only for Superflat: one row per
// layer, top layer first, each with a block picker, a height, move up / down and remove, with Add layer, Reset to Classic
// and the total height. Controls carry the ids `<prefix>-<key>` (world-name, world-seed, world-gameMode…; host-* for the
// hosting copy). values() returns everything CloudSaveManager.createWorld takes.

import { SettingRow } from './SettingRow.js';
import { CREATE_WORLD_ROWS, WORLD_DEFAULTS } from '../core/WorldSettings.js';
import { CLASSIC_FLAT_LAYERS, FLAT_MAX_LAYERS, FLAT_MAX_LAYER_HEIGHT, FLAT_MAX_HEIGHT, flatLayerBlockNames, flatHeight, normalizeFlatLayers } from '../generation/Superflat.js';
import { BlockRegistry } from '../blocks/BlockRegistry.js';
import { hashSeed, randomSeed } from '../utils/Random.js';

export class CreateWorldForm {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {HTMLElement} container  the list element the rows go into
   * @param {{ idPrefix: string, onSubmit: () => void }} opts  control id prefix ('world' / 'host'); Enter in a text box submits
   */
  constructor(game, container, { idPrefix, onSubmit }) {
    this.game = game;
    this.root = container;
    this.idPrefix = idPrefix;
    this.onSubmit = onSubmit;
    /** key → SettingRow */
    this.rows = new Map();
    this.data = {};
    this.layerRoot = null; this.layerList = null; this.layerTotal = null; this.layerAdd = null;
    this.store = { get: (key) => this.data[key], set: (key, value) => this._set(key, value) };
    this.reset(false);
    this._build();
    this.refresh();
  }

  /** Every value back to its default (the Classic layers included). */
  reset(refresh = true) {
    this.data = { name: 'New World', seed: '' };
    for (const row of CREATE_WORLD_ROWS) if (row.key !== 'name' && row.key !== 'seed') this.data[row.key] = row.key === 'flatLayers' ? CLASSIC_FLAT_LAYERS.map((l) => ({ ...l })) : WORLD_DEFAULTS[row.key];
    if (refresh) this.refresh();
  }

  _build() {
    for (const schema of CREATE_WORLD_ROWS) {
      if (schema.type === 'layers') { this._buildLayerEditor(schema); continue; }
      const row = new SettingRow(this.game, { ...schema, idPrefix: this.idPrefix, onEnter: () => { if (this.onSubmit) this.onSubmit(); } }, null, this.store);
      this.rows.set(schema.key, row);
      this.root.appendChild(row.row);
    }
  }

  /** A value changed through its row (or setValue): the dependent rows follow. */
  _set(key, value) {
    this.data[key] = value;
    if (key === 'worldType') this._updateLayerEditor();
    if (key === 'modeLocked') this._updateLockRows();
    if (key === 'naturalMobs') this.rows.get('hostileMobs').setEnabled(!!value);
    if (key === 'flatLayers') this._renderLayers();
  }

  /** Set a value from code (the tests): the row shows it and the dependent rows follow. */
  setValue(key, value) { this._set(key, value); const row = this.rows.get(key); if (row) row.refresh(); }

  /** Show every stored value. */
  refresh() {
    for (const row of this.rows.values()) row.refresh();
    this.rows.get('hostileMobs').setEnabled(!!this.data.naturalMobs);
    this._updateLayerEditor();
    this._updateLockRows();
    this._renderLayers();
  }

  /** The game mode lock holds everyone to the owner's mode: the "Game mode for other players" row is hidden while it is on. */
  _updateLockRows() { const row = this.rows.get('defaultGameMode'); if (row) row.row.classList.toggle('hidden', !!this.data.modeLocked); }

  /** Enable or disable every control (while the world is being created). */
  setBusy(busy) {
    for (const row of this.rows.values()) row.setEnabled(!busy, false);
    if (this.layerRoot) for (const el of this.layerRoot.querySelectorAll('button, select, input')) el.disabled = busy;
    if (!busy) { this.rows.get('hostileMobs').setEnabled(!!this.data.naturalMobs); this._renderLayers(); }
  }

  focus() { const r = this.rows.get('name'); if (r) r.control.focus(); }

  /**
   * What createWorld takes: the trimmed name ("New World" when empty), the seed text and its hash (random when blank), the
   * game mode, and every world setting; the layers only for a Superflat world (normalised).
   */
  values() {
    const d = this.data;
    const name = String(d.name || '').trim() || 'New World';
    const seedText = String(d.seed || '').trim();
    const out = { name, seedText, seed: seedText ? hashSeed(seedText) : randomSeed() };
    for (const row of CREATE_WORLD_ROWS) {
      if (row.key === 'name' || row.key === 'seed') continue;
      if (row.key === 'flatLayers') { if (d.worldType === 'superflat') out.flatLayers = normalizeFlatLayers(d.flatLayers).layers; continue; }
      out[row.key] = d[row.key];
    }
    if (out.modeLocked) out.defaultGameMode = out.gameMode; // a locked world ignores the setting: everyone plays the locked mode
    return out;
  }

  // ---- the Superflat layer editor ----

  _buildLayerEditor(schema) {
    const root = document.createElement('div');
    root.className = 'option-row flat-editor hidden'; // not `wide`: that rule stretches every button to the full width
    root.id = `${this.idPrefix}-${schema.key}`;
    root.dataset.key = schema.key;
    const head = document.createElement('div'); head.className = 'option-text';
    const label = document.createElement('span'); label.className = 'option-label'; label.textContent = schema.label;
    const hint = document.createElement('div'); hint.className = 'option-hint'; hint.textContent = schema.hint;
    head.append(label, hint);
    this.layerList = document.createElement('div'); this.layerList.className = 'flat-layers';
    const foot = document.createElement('div'); foot.className = 'flat-foot';
    this.layerTotal = document.createElement('div'); this.layerTotal.className = 'option-hint flat-total';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'mc-button small flat-add'; add.textContent = 'Add layer';
    add.addEventListener('click', () => { this.game.audio.playUI('click'); this._addLayer(); });
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'mc-button small flat-reset'; reset.textContent = 'Reset to Classic';
    reset.addEventListener('click', () => { this.game.audio.playUI('click'); this.setValue('flatLayers', CLASSIC_FLAT_LAYERS.map((l) => ({ ...l }))); });
    const buttons = document.createElement('div'); buttons.className = 'flat-buttons'; buttons.append(add, reset);
    foot.append(this.layerTotal, buttons);
    root.append(head, this.layerList, foot);
    this.layerRoot = root; this.layerAdd = add;
    this.root.appendChild(root);
  }

  _updateLayerEditor() { if (this.layerRoot) this.layerRoot.classList.toggle('hidden', this.data.worldType !== 'superflat'); }

  /** The list, TOP layer first (the way the world looks from the side); the data stays bottom to top. */
  _renderLayers() {
    if (!this.layerList) return;
    const layers = this.data.flatLayers;
    this.layerList.textContent = '';
    const names = flatLayerBlockNames();
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const row = document.createElement('div'); row.className = 'flat-layer'; row.dataset.index = String(i);
      const sel = document.createElement('select'); sel.className = 'flat-block'; sel.title = 'Block';
      for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = BlockRegistry.displayName(BlockRegistry.idOf(n)); sel.appendChild(o); }
      sel.value = layer.block;
      sel.addEventListener('change', () => { this.game.audio.playUI('click'); layer.block = sel.value; this._layersChanged(); });
      const h = document.createElement('input'); h.type = 'number'; h.className = 'flat-height'; h.min = '1'; h.max = String(FLAT_MAX_LAYER_HEIGHT); h.step = '1'; h.value = String(layer.height); h.title = 'Height in blocks';
      h.addEventListener('focus', () => { this.game.input.textInputActive = true; });
      h.addEventListener('blur', () => { this.game.input.textInputActive = false; });
      h.addEventListener('keydown', (e) => e.stopPropagation());
      h.addEventListener('change', () => { layer.height = Math.max(1, Math.min(FLAT_MAX_LAYER_HEIGHT, Math.round(Number(h.value) || 1))); this._layersChanged(); });
      const btn = (text, title, cls, fn, disabled = false) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mc-button tiny ' + cls; b.textContent = text; b.title = title; b.disabled = disabled; b.addEventListener('click', () => { this.game.audio.playUI('click'); fn(); }); return b; };
      // "Up" on screen is toward the top of the world: a larger index in the bottom-to-top data.
      const up = btn('▲', 'Move up', 'flat-up', () => this._moveLayer(i, 1), i === layers.length - 1);
      const down = btn('▼', 'Move down', 'flat-down', () => this._moveLayer(i, -1), i === 0);
      const del = btn('✕', 'Remove', 'flat-remove', () => { layers.splice(i, 1); this._layersChanged(); }, layers.length <= 1);
      row.append(sel, h, up, down, del);
      this.layerList.appendChild(row);
    }
    const total = flatHeight(layers);
    this.layerTotal.textContent = `Total height: ${total} of ${FLAT_MAX_HEIGHT} blocks · ${layers.length} of ${FLAT_MAX_LAYERS} layers`;
    if (this.layerAdd) this.layerAdd.disabled = layers.length >= FLAT_MAX_LAYERS || total >= FLAT_MAX_HEIGHT;
  }

  /** Clamp as the generator would (heights 1–64, the total within the limit), then redraw. */
  _layersChanged() {
    this.data.flatLayers = normalizeFlatLayers(this.data.flatLayers).layers;
    this._renderLayers();
  }

  _addLayer() {
    const layers = this.data.flatLayers;
    if (layers.length >= FLAT_MAX_LAYERS || flatHeight(layers) >= FLAT_MAX_HEIGHT) return;
    const top = layers[layers.length - 1];
    layers.push({ block: top ? top.block : 'dirt', height: 1 }); // a new top layer of the same block, one block tall
    this._layersChanged();
  }

  _moveLayer(i, dir) {
    const layers = this.data.flatLayers, j = i + dir;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    this._renderLayers();
  }
}
