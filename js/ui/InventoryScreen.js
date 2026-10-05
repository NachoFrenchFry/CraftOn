// InventoryScreen.js — the E / crafting table / furnace screen (bloxd.io style, Update #5). Right panel:
// 5 armor slots over a 6×6 storage grid; hotbar row below both panels; left panel: the recipe browser
// ("Hand Crafting" / "Crafting Table" / "Furnace") or, in Creative, a searchable item catalog with an
// Items / Hand Crafting toggle. Minecraft click semantics: pick up, place, merge, swap, split, place-one,
// shift quick-move (armor goes straight to its slot), number-key swap, drag distribution, double-click
// gather, cursor stack, tooltips. Only the matching armor type fits each armor slot.

import { ItemStack } from '../items/ItemStack.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { Inventory, HOTBAR_SIZE, INVENTORY_SIZE, ARMOR_START, TOTAL_SLOTS, ARMOR_SLOTS } from '../items/Inventory.js';
import { ItemIds } from '../items/ItemDefinitions.js';
import { CraftingPanel } from './CraftingPanel.js';
import { itemStatLines } from '../items/Tools.js';

const STATION_TITLES = { inventory: 'Hand Crafting', crafting_table: 'Crafting Table', furnace: 'Furnace' };
/** Iron pieces provide the faint silhouettes drawn in empty armor slots. */
const SILHOUETTE_ITEMS = { helmet: ItemIds.IRON_HELMET, chestplate: ItemIds.IRON_CHESTPLATE, gauntlets: ItemIds.IRON_GAUNTLETS, leggings: ItemIds.IRON_LEGGINGS, boots: ItemIds.IRON_BOOTS };

export class InventoryScreen {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.inventory = game.inventory;
    this.icons = game.icons;
    this.root = document.getElementById('inventory-screen');
    this.leftPanel = document.getElementById('inv-left');
    this.mainGrid = document.getElementById('inv-main');
    this.hotbarGrid = document.getElementById('inv-hotbar');
    this.armorRow = document.getElementById('inv-armor');
    this.catalogPanel = document.getElementById('catalog-panel');
    this.catalogGrid = document.getElementById('catalog-grid');
    this.searchInput = document.getElementById('catalog-search');
    this.toggle = document.getElementById('inv-toggle');
    this.tabItems = document.getElementById('inv-tab-items');
    this.tabCraft = document.getElementById('inv-tab-craft');
    this.craftArea = document.getElementById('inv-crafting');
    this.cursorEl = document.getElementById('cursor-stack');
    this.tooltip = document.getElementById('tooltip');
    this.titleEl = document.getElementById('inv-title');
    this.crafting = new CraftingPanel(this.craftArea, game, { show: (n, l) => this._showTooltip(n, l), hide: () => this.tooltip.classList.add('hidden') });
    /** 'inventory' | 'crafting_table' | 'furnace' */
    this.station = 'inventory';
    /** Creative left panel: 'items' | 'craft' */
    this.creativeView = 'items';
    this.cursor = null;          // ItemStack on the mouse
    this.slotEls = [];
    this.lastState = new Array(TOTAL_SLOTS).fill(null); // null = "never drawn": an empty slot's key is '' and must still repaint
    this.hoverIndex = -1;
    this.drag = null;            // { button, origin, slots:Set }
    this.lastClick = { index: -1, time: 0 };
    this.mouseX = 0; this.mouseY = 0;
    this.visible = false;
    this._build();
    this._bind();
    game.events.on('inventory:changed', () => { if (this.visible) { this.refresh(); this.crafting.refresh(); } });
  }

  _makeSlot(index, extraClass = '') {
    const el = document.createElement('div');
    el.className = 'slot' + (extraClass ? ' ' + extraClass : '');
    el.dataset.index = String(index);
    const icon = document.createElement('div');
    icon.className = 'slot-icon';
    const count = document.createElement('div');
    count.className = 'slot-count';
    el.append(icon, count);
    return { el, icon, count };
  }

  _build() {
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) { const s = this._makeSlot(i); this.mainGrid.appendChild(s.el); this.slotEls[i] = s; }
    for (let i = 0; i < HOTBAR_SIZE; i++) { const s = this._makeSlot(i); this.hotbarGrid.appendChild(s.el); this.slotEls[i] = s; }
    ARMOR_SLOTS.forEach((slot, k) => {
      const s = this._makeSlot(ARMOR_START + k, 'armor-slot');
      s.el.dataset.armor = slot;
      const sil = document.createElement('div');
      sil.className = 'slot-silhouette';
      sil.style.backgroundImage = `url(${this.icons.getSilhouette(SILHOUETTE_ITEMS[slot])})`;
      s.el.appendChild(sil);
      this.armorRow.appendChild(s.el);
      this.slotEls[ARMOR_START + k] = s;
    });
    const cursorIcon = document.createElement('div');
    cursorIcon.className = 'slot-icon';
    const cursorCount = document.createElement('div');
    cursorCount.className = 'slot-count';
    this.cursorEl.append(cursorIcon, cursorCount);
    this.cursorIcon = cursorIcon;
    this.cursorCount = cursorCount;
    this.catalogEls = [];
    this.catalogBuilt = false;
  }

  /** Creative catalog: every item, including creative-only ones such as spawn eggs. Built (icons drawn) on first use, not at boot. */
  _buildCatalog() {
    if (this.catalogBuilt) return;
    this.catalogBuilt = true;
    const t0 = performance.now();
    for (const item of ItemRegistry.all()) {
      const el = document.createElement('div');
      el.className = 'slot catalog-slot';
      el.dataset.item = String(item.id);
      const icon = document.createElement('div');
      icon.className = 'slot-icon';
      icon.style.backgroundImage = `url(${this.icons.getIcon(item.id)})`;
      el.appendChild(icon);
      this.catalogGrid.appendChild(el);
      this.catalogEls.push({ el, name: item.displayName.toLowerCase() });
    }
    if (this.game.timing) this.game.timing.add('catalog icons (first inventory open)', performance.now() - t0, `${this.catalogEls.length} icons`);
    this._applyFilter();
  }

  _bind() {
    const slotFromEvent = (e) => {
      const el = e.target.closest('.slot');
      if (!el || !this.root.contains(el)) return null;
      return el;
    };
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.searchInput) return; // let the search box take focus
      e.preventDefault();
      if (this.searchInput === document.activeElement) this.searchInput.blur();
      const el = slotFromEvent(e);
      if (!el) {
        if (this.cursor && this.catalogPanel.contains(e.target) && !this.catalogPanel.classList.contains('hidden')) { this._deleteCursor(); return; }
        if (e.target === this.root && this.cursor) this._dropCursor();
        return;
      }
      if (el.dataset.item !== undefined) { this._catalogClick(parseInt(el.dataset.item, 10), e.button, e.shiftKey); return; }
      if (el.dataset.recipe !== undefined) return; // handled by the crafting panel
      const index = parseInt(el.dataset.index, 10);
      this.drag = { button: e.button, origin: index, shift: e.shiftKey, slots: new Set() };
      if (this.cursor && (e.button === 0 || e.button === 2)) this._tryAddDragSlot(index);
    });
    this.root.addEventListener('mouseover', (e) => {
      const el = slotFromEvent(e);
      if (el && el.dataset.index !== undefined) {
        this.hoverIndex = parseInt(el.dataset.index, 10);
        if (this.drag && this.cursor) this._tryAddDragSlot(this.hoverIndex);
      } else this.hoverIndex = -1;
      if (!el || el.dataset.recipe === undefined) this._updateTooltip(el);
    });
    this.root.addEventListener('mouseout', (e) => {
      const el = slotFromEvent(e);
      if (el && el.dataset.recipe === undefined) { this.hoverIndex = -1; this.tooltip.classList.add('hidden'); }
    });
    window.addEventListener('mouseup', () => {
      if (!this.visible || !this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.slots.size >= 2 && this.cursor) this._distribute(d);
      else this._click(d.origin, d.button, d.shift);
    });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (!this.visible) return;
      this.cursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
      if (!this.tooltip.classList.contains('hidden')) this._positionTooltip();
    });
    this.game.events.on('input:keydown', (code) => {
      if (!this.visible) return;
      const hotbarAction = this.game.actions.actionsFor(code).find((a) => /^hotbar[1-9]$/.test(a));
      if (hotbarAction && this.hoverIndex >= 0) {
        const hb = parseInt(hotbarAction.slice(6), 10) - 1;
        if (hb !== this.hoverIndex && this.inventory.swap(hb, this.hoverIndex)) this.game.audio.playUI('click', 0.5);
      }
    });
    // Creative: search filters live; Escape leaves the box and closes the screen; the toggle switches views.
    this.searchInput.addEventListener('input', () => this._applyFilter());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.searchInput.blur(); this.game.closeInventory(); }
      e.stopPropagation();
    });
    this.tabItems.addEventListener('click', () => this._setCreativeView('items'));
    this.tabCraft.addEventListener('click', () => this._setCreativeView('craft'));
  }

  _setCreativeView(view) {
    this.creativeView = view;
    this.tabItems.classList.toggle('active', view === 'items');
    this.tabCraft.classList.toggle('active', view === 'craft');
    this.catalogPanel.classList.toggle('hidden', view !== 'items');
    this.craftArea.classList.toggle('hidden', view !== 'craft');
    this.titleEl.classList.toggle('hidden', view === 'items');
    if (view === 'craft') { this.titleEl.textContent = STATION_TITLES.inventory; this.crafting.setStation('inventory'); }
    this.game.audio.playUI('click', 0.4);
  }

  _applyFilter() {
    const q = this.searchInput.value.trim().toLowerCase();
    for (const c of this.catalogEls) c.el.classList.toggle('filtered', q !== '' && !c.name.includes(q));
  }

  // ---- Click semantics ----

  _click(index, button, shift) {
    const inv = this.inventory;
    const slot = inv.get(index);
    const now = performance.now();
    const isDouble = button === 0 && this.lastClick.index === index && now - this.lastClick.time < 300;
    this.lastClick = { index, time: now };
    const armor = Inventory.isArmorIndex(index);
    const fits = (stack) => !stack || inv.acceptsAt(index, stack.itemId);
    if (button === 0) {
      if (shift) {
        if (slot) this._quickMove(index);
      } else if (isDouble && this.cursor && !armor) {
        this._gather();
      } else if (!this.cursor) {
        if (slot) { this.cursor = slot; inv.set(index, null); }
      } else if (!slot) {
        if (fits(this.cursor)) { inv.set(index, this.cursor); this.cursor = null; }
      } else if (slot.canMergeWith(this.cursor)) {
        slot.absorb(this.cursor);
        if (this.cursor.count <= 0) this.cursor = null;
        inv.changed();
      } else if (fits(this.cursor)) {
        const t = this.cursor; this.cursor = slot; inv.set(index, t);
      }
    } else if (button === 2) {
      if (!this.cursor) {
        if (slot) { this.cursor = inv.split(index); }
      } else if (!slot) {
        if (fits(this.cursor)) {
          inv.set(index, this.cursor.take(1));
          if (this.cursor.count <= 0) this.cursor = null;
        }
      } else if (slot.canMergeWith(this.cursor) && slot.count < slot.maxStack) {
        slot.count++; this.cursor.count--;
        if (this.cursor.count <= 0) this.cursor = null;
        inv.changed();
      } else if (!slot.canMergeWith(this.cursor) && fits(this.cursor)) {
        const t = this.cursor; this.cursor = slot; inv.set(index, t);
      }
    }
    this.game.audio.playUI('click', 0.5);
    this.refresh();
  }

  /** Shift-click: armor goes to its armor slot; armor slots empty into storage; otherwise hotbar ↔ storage. */
  _quickMove(index) {
    const inv = this.inventory;
    const stack = inv.get(index);
    if (!stack) return;
    if (!Inventory.isArmorIndex(index)) {
      const armorIndex = Inventory.armorIndexFor(stack.itemId);
      if (armorIndex >= 0 && !inv.get(armorIndex)) { inv.slots[armorIndex] = stack; inv.slots[index] = null; inv.changed(); return; }
    }
    const [from, to] = Inventory.isArmorIndex(index) ? [HOTBAR_SIZE, INVENTORY_SIZE] : index < HOTBAR_SIZE ? [HOTBAR_SIZE, INVENTORY_SIZE] : [0, HOTBAR_SIZE];
    for (let i = from; i < to && stack.count > 0; i++) {
      const s = inv.get(i);
      if (s && s.canMergeWith(stack)) s.absorb(stack);
    }
    for (let i = from; i < to && stack.count > 0; i++) {
      if (!inv.get(i)) { inv.slots[i] = stack.take(stack.count); }
    }
    if (stack.count <= 0) inv.slots[index] = null;
    inv.changed();
  }

  /** Double-click: gather all matching items (hotbar + storage) onto the cursor. */
  _gather() {
    const inv = this.inventory;
    const c = this.cursor;
    for (let i = 0; i < INVENTORY_SIZE && c.count < c.maxStack; i++) {
      const s = inv.get(i);
      if (s && s.canMergeWith(c)) { c.absorb(s); if (s.count <= 0) inv.slots[i] = null; }
    }
    inv.changed();
  }

  _tryAddDragSlot(index) {
    if (Inventory.isArmorIndex(index)) return;
    const s = this.inventory.get(index);
    if (!s || s.canMergeWith(this.cursor)) this.drag.slots.add(index);
  }

  /** Drag distribution: left = split evenly, right = one per slot. */
  _distribute(d) {
    const inv = this.inventory;
    const c = this.cursor;
    const slots = [...d.slots];
    const per = d.button === 0 ? Math.floor(c.count / slots.length) : 1;
    if (per <= 0) { this.refresh(); return; }
    for (const i of slots) {
      if (c.count <= 0) break;
      let s = inv.get(i);
      if (!s) { s = new ItemStack(c.itemId, 0); inv.slots[i] = s; }
      const room = s.maxStack - s.count;
      const n = Math.min(per, room, c.count);
      s.count += n; c.count -= n;
      if (s.count <= 0) inv.slots[i] = null;
    }
    if (c.count <= 0) this.cursor = null;
    inv.changed();
    this.game.audio.playUI('click', 0.5);
    this.refresh();
  }

  /** Creative catalog: click takes a full stack, shift-click sends one to the hotbar / storage; with a stack on the cursor the click deletes it. */
  _catalogClick(itemId, button, shift) {
    const item = ItemRegistry.get(itemId);
    if (!item) return;
    if (this.cursor) { this._deleteCursor(); return; }
    if (shift) this.inventory.addItem(itemId, item.stackSize);
    else this.cursor = new ItemStack(itemId, item.stackSize);
    this.game.audio.playUI('click', 0.5);
    this.refresh();
  }

  /** Dropping a stack onto the catalog destroys it. */
  _deleteCursor() {
    if (!this.cursor) return;
    this.cursor = null;
    this.game.audio.playUI('click', 0.5);
    this.refresh();
  }

  /** Drop the cursor stack into the world (click outside the panels). */
  _dropCursor() {
    if (!this.cursor) return;
    this.game.entities.throwFromPlayer(this.cursor.itemId, this.cursor.count);
    this.cursor = null;
    this.refresh();
  }

  // ---- Rendering ----

  _showTooltip(name, lines) {
    if (this.cursor) { this.tooltip.classList.add('hidden'); return; }
    this.tooltip.textContent = '';
    const el = document.createElement('div');
    el.textContent = name;
    this.tooltip.appendChild(el);
    for (const line of lines) {
      const stat = document.createElement('div');
      stat.className = 'tip-stat ' + line.color;
      stat.textContent = line.text;
      this.tooltip.appendChild(stat);
    }
    this.tooltip.classList.remove('hidden');
    this._positionTooltip();
  }

  _updateTooltip(el) {
    let text = '', itemId = null;
    if (el) {
      if (el.dataset.index !== undefined) {
        const s = this.inventory.get(parseInt(el.dataset.index, 10));
        if (s) { text = s.displayName; itemId = s.itemId; }
        else if (el.dataset.armor) text = el.dataset.armor.charAt(0).toUpperCase() + el.dataset.armor.slice(1);
      } else if (el.dataset.item !== undefined) { itemId = parseInt(el.dataset.item, 10); text = ItemRegistry.displayName(itemId); }
    }
    if (!text || this.cursor) { this.tooltip.classList.add('hidden'); return; }
    this._showTooltip(text, itemId !== null ? itemStatLines(itemId) : []);
  }

  _positionTooltip() {
    this.tooltip.style.left = `${this.mouseX + 12}px`;
    this.tooltip.style.top = `${this.mouseY - 12}px`;
  }

  refresh() {
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const stack = this.inventory.get(i);
      const key = stack ? `${stack.itemId}:${stack.count}` : '';
      if (key === this.lastState[i]) continue;
      this.lastState[i] = key;
      const s = this.slotEls[i];
      s.icon.style.backgroundImage = stack ? `url(${this.icons.getIcon(stack.itemId)})` : '';
      s.count.textContent = stack && stack.count > 1 ? String(stack.count) : '';
      if (Inventory.isArmorIndex(i)) s.el.classList.toggle('filled', !!stack);
    }
    if (this.cursor) {
      this.cursorEl.classList.remove('hidden');
      this.cursorIcon.style.backgroundImage = `url(${this.icons.getIcon(this.cursor.itemId)})`;
      this.cursorCount.textContent = this.cursor.count > 1 ? String(this.cursor.count) : '';
      this.tooltip.classList.add('hidden');
    } else {
      this.cursorEl.classList.add('hidden');
    }
  }

  /** @param {'inventory'|'crafting_table'|'furnace'} station which left panel to show */
  open(station = 'inventory') {
    this.visible = true;
    this.station = station;
    this.root.classList.remove('hidden');
    const creative = this.game.player.isCreative && station === 'inventory';
    this.toggle.classList.toggle('hidden', !creative);
    if (creative) {
      this._buildCatalog();
      this._setCreativeView(this.creativeView);
    } else {
      this.catalogPanel.classList.add('hidden');
      this.craftArea.classList.remove('hidden');
      this.titleEl.classList.remove('hidden');
      this.titleEl.textContent = STATION_TITLES[station] || STATION_TITLES.inventory;
      this.crafting.setStation(station);
    }
    this.lastState.fill(null); // Update #7 fix: slots emptied while the screen was closed used to keep their old icon
    this.refresh();
    this.cursorEl.style.transform = `translate(${this.mouseX}px, ${this.mouseY}px) translate(-50%, -50%)`;
  }

  /** Close; returns cursor items to the inventory or drops them when full. */
  close() {
    this.visible = false;
    this.drag = null;
    if (this.searchInput === document.activeElement) this.searchInput.blur();
    if (this.cursor) {
      const left = this.inventory.addItem(this.cursor.itemId, this.cursor.count);
      if (left > 0) this.game.entities.throwFromPlayer(this.cursor.itemId, left);
      this.cursor = null;
    }
    this.cursorEl.classList.add('hidden');
    this.tooltip.classList.add('hidden');
    this.root.classList.add('hidden');
  }

  update() {}
}
