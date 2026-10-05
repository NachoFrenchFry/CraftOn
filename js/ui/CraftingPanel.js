// CraftingPanel.js — the recipe browser inside the left inventory panel (bloxd.io style, Update #5): a
// 6-column grid of result-icon tiles (dimmed when unaffordable) and, for the selected recipe, its name,
// the material icons with have/need count badges (red when short) and a big blue craft button showing the
// result icon and output count. Click crafts once, shift-click crafts as many as possible.

import { ItemRegistry } from '../items/ItemRegistry.js';

export class CraftingPanel {
  /**
   * @param {HTMLElement} root the craft-area container
   * @param {import('../core/Game.js').Game} game
   * @param {{ show(name: string, lines: {text: string, color: string}[]): void, hide(): void }} tooltip
   */
  constructor(root, game, tooltip) {
    this.root = root;
    this.game = game;
    this.tooltip = tooltip;
    this.station = null;
    this.selected = null;
    /** [{ recipe, tile }] */
    this.tiles = [];
    this.grid = document.createElement('div');
    this.grid.className = 'recipe-grid';
    this.detail = document.createElement('div');
    this.detail.className = 'recipe-detail hidden';
    root.append(this.grid, this.detail);
    root.addEventListener('mousedown', (e) => e.stopPropagation()); // keep the slot logic out
    this.grid.addEventListener('click', (e) => {
      const tile = e.target.closest('.recipe-tile');
      const t = tile && this.tiles.find((x) => x.tile === tile);
      if (t) { this.select(t.recipe); this.game.audio.playUI('click', 0.4); }
    });
    this.grid.addEventListener('mouseover', (e) => {
      const tile = e.target.closest('.recipe-tile');
      const t = tile && this.tiles.find((x) => x.tile === tile);
      if (t) this.tooltip.show(ItemRegistry.displayName(t.recipe.result.itemId), []);
    });
    this.grid.addEventListener('mouseout', () => this.tooltip.hide());
  }

  /** Rebuild for a station ('inventory' | 'crafting_table' | 'furnace'); keeps the selection if possible. */
  setStation(station) {
    this.station = station;
    this.grid.innerHTML = '';
    this.tiles = [];
    for (const recipe of this.game.crafting.recipesFor(station)) {
      const tile = document.createElement('div');
      tile.className = 'slot recipe-tile';
      tile.dataset.recipe = recipe.id;
      const icon = document.createElement('div');
      icon.className = 'slot-icon';
      icon.style.backgroundImage = `url(${this.game.icons.getIcon(recipe.result.itemId)})`;
      tile.appendChild(icon);
      this.grid.appendChild(tile);
      this.tiles.push({ recipe, tile });
    }
    const keep = this.selected && this.tiles.find((t) => t.recipe.id === this.selected.id);
    this.select(keep ? keep.recipe : (this.tiles[0] ? this.tiles[0].recipe : null));
  }

  select(recipe) {
    this.selected = recipe;
    for (const t of this.tiles) t.tile.classList.toggle('selected', t.recipe === recipe);
    this._buildDetail();
    this.refresh();
  }

  _buildDetail() {
    const d = this.detail;
    d.innerHTML = '';
    this.materialEls = [];
    const recipe = this.selected;
    if (!recipe) { d.classList.add('hidden'); return; }
    d.classList.remove('hidden');
    const icons = this.game.icons;
    const name = document.createElement('div');
    name.className = 'recipe-name';
    name.textContent = ItemRegistry.displayName(recipe.result.itemId);
    d.appendChild(name);
    const mats = document.createElement('div');
    mats.className = 'recipe-materials';
    for (const input of recipe.inputs) {
      const m = document.createElement('div');
      m.className = 'recipe-material';
      const icon = document.createElement('div');
      icon.className = 'slot-icon';
      icon.style.backgroundImage = `url(${icons.getIcon(input.itemId)})`;
      const badge = document.createElement('span');
      badge.className = 'recipe-badge';
      m.append(icon, badge);
      m.addEventListener('mouseover', () => {
        const have = this.game.inventory.countOf(input.itemId);
        this.tooltip.show(ItemRegistry.displayName(input.itemId), [{ text: `${have} / ${input.count}`, color: have >= input.count ? 'green' : 'gray' }]);
      });
      m.addEventListener('mouseout', () => this.tooltip.hide());
      mats.appendChild(m);
      this.materialEls.push({ badge, need: input.count, itemId: input.itemId });
    }
    d.appendChild(mats);
    const button = document.createElement('div');
    button.className = 'craft-button';
    button.id = 'craft-button';
    const icon = document.createElement('div');
    icon.className = 'slot-icon';
    icon.style.backgroundImage = `url(${icons.getIcon(recipe.result.itemId)})`;
    const count = document.createElement('span');
    count.className = 'craft-count';
    count.textContent = recipe.result.count > 1 ? String(recipe.result.count) : '';
    button.append(icon, count);
    button.addEventListener('click', (e) => this._craft(e.shiftKey ? 'max' : 'once'));
    button.addEventListener('mouseover', () => this.tooltip.show(`${this.verb} ${ItemRegistry.displayName(recipe.result.itemId)}`, [{ text: 'Shift-click: as many as possible', color: 'gray' }]));
    button.addEventListener('mouseout', () => this.tooltip.hide());
    this.button = button;
    d.appendChild(button);
  }

  get verb() { return this.station === 'furnace' ? 'Smelt' : 'Craft'; }

  _craft(times) {
    if (!this.selected || this.game.crafting.craftableCount(this.selected) <= 0) { this.game.audio.playUI('click', 0.3); return; }
    this.game.crafting.craft(this.selected, times);
    this.refresh(); // the selection stays so the button can be clicked repeatedly
  }

  /** Update tile affordability, count badges and the button state. */
  refresh() {
    const inv = this.game.inventory;
    for (const t of this.tiles) t.tile.classList.toggle('affordable', this.game.crafting.craftableCount(t.recipe) > 0);
    if (!this.selected || !this.button) return;
    let ok = true;
    for (const m of this.materialEls) {
      const have = inv.countOf(m.itemId);
      const enough = have >= m.need;
      if (!enough) ok = false;
      const text = String(m.need);
      if (m.badge.textContent !== text) m.badge.textContent = text;
      m.badge.classList.toggle('short', !enough);
    }
    this.button.classList.toggle('disabled', !ok);
  }
}
