// InventoryScreen.js — the E / crafting table / furnace screen (bloxd.io style). Right panel:
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
import { clickSlot, putIntoSlot } from '../items/SlotClick.js';
import { CHEST_SLOTS } from '../config/Constants.js';

const STATION_TITLES = { inventory: 'Hand Crafting', crafting_table: 'Crafting Table', furnace: 'Furnace' };
/** A slot's address on the screen: the inventory ('inv') or the open chest ('chest'). */
const slotKey = (space, index) => `${space}:${index}`;
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
    this.chestPanel = document.getElementById('chest-panel');
    this.chestGrid = document.getElementById('chest-grid');
    /** The open chest (ChestStorage) and its block position while the station is 'chest'. */
    this.chest = null;
    this.chestPos = null;
    this.chestSlotEls = [];
    this.lastChestState = new Array(CHEST_SLOTS).fill(null);
    /** A guest's chest click waits for the host's answer; further chest clicks are ignored meanwhile. */
    this.pendingOp = null;
    this.crafting = new CraftingPanel(this.craftArea, game, { show: (n, l) => this._showTooltip(n, l), hide: () => this.tooltip.classList.add('hidden') });
    /** 'inventory' | 'crafting_table' | 'furnace' */
    this.station = 'inventory';
    /** Creative left panel: 'items' | 'craft' */
    this.creativeView = 'items';
    this.cursor = null;          // ItemStack on the mouse
    this.slotEls = [];
    this.lastState = new Array(TOTAL_SLOTS).fill(null); // null = "never drawn": an empty slot's key is '' and must still repaint
    this.hoverIndex = -1;
    this.hoverSpace = 'inv';
    this.drag = null;            // { button, origin: { space, index }, shift, slots: Set<"space:index"> }
    this.lastClick = { index: -1, time: 0 };
    this.mouseX = 0; this.mouseY = 0;
    this.visible = false;
    this._build();
    this._bind();
    game.events.on('inventory:changed', () => { if (this.visible) { this.refresh(); this.crafting.refresh(); } });
    game.events.on('chest:changed', (x, y, z) => { if (this.visible && this.chestPos && this.chestPos.x === x && this.chestPos.y === y && this.chestPos.z === z) this.refresh(); });
  }

  /** 'inv' or 'chest' for a slot element. */
  _space(el) { return el.dataset.space || 'inv'; }
  /** The store behind a space (the Inventory or the open ChestStorage). */
  _store(space) { return space === 'chest' ? this.chest : this.inventory; }
  get isGuest() { return !!this.game.isGuest; }

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
    for (let i = 0; i < CHEST_SLOTS; i++) { const s = this._makeSlot(i); s.el.dataset.space = 'chest'; this.chestGrid.appendChild(s.el); this.chestSlotEls[i] = s; }
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
    for (const item of ItemRegistry.catalog()) { // catalog order: by category, then tier (wood → stone → gold → iron → diamond)
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
      const index = parseInt(el.dataset.index, 10), space = this._space(el);
      this.drag = { button: e.button, origin: { space, index }, shift: e.shiftKey, slots: new Set() };
      if (this.cursor && (e.button === 0 || e.button === 2)) this._tryAddDragSlot(space, index);
    });
    this.root.addEventListener('mouseover', (e) => {
      const el = slotFromEvent(e);
      if (el && el.dataset.index !== undefined) {
        this.hoverIndex = parseInt(el.dataset.index, 10);
        this.hoverSpace = this._space(el);
        if (this.drag && this.cursor) this._tryAddDragSlot(this.hoverSpace, this.hoverIndex);
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
      else this._click(d.origin.space, d.origin.index, d.button, d.shift);
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
        if (this.hoverSpace === 'chest') { if (this._swapChestWithHotbar(this.hoverIndex, hb)) this.game.audio.playUI('click', 0.5); }
        else if (hb !== this.hoverIndex && this.inventory.swap(hb, this.hoverIndex)) this.game.audio.playUI('click', 0.5);
      }
    });
    // Creative: search filters live; Escape leaves the box and closes the screen; the toggle switches views.
    this.searchInput.addEventListener('input', () => this._applyFilter());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.searchInput.blur(); this.game.closeInventory(false); }
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

  /** A click on a slot of either space: the Minecraft semantics (SlotClick.js), with the armor slots' type rule. */
  _click(space, index, button, shift) {
    const store = this._store(space);
    if (!store) return;
    if (space === 'chest' && this.isGuest) { this._guestChestClick(index, button, shift); return; }
    const slot = store.get(index);
    const now = performance.now();
    const isDouble = button === 0 && this.lastClick.index === index && this.lastClick.space === space && now - this.lastClick.time < 300;
    this.lastClick = { index, space, time: now };
    const armor = space === 'inv' && Inventory.isArmorIndex(index);
    if (button === 0 && shift) { if (slot) this._quickMove(space, index); }
    else if (button === 0 && isDouble && this.cursor && !armor) this._gather();
    else if (button === 0 || button === 2) {
      const r = clickSlot(slot, this.cursor, button);
      if (!(armor && r.slot && !this.inventory.acceptsAt(index, r.slot.itemId))) { store.set(index, r.slot); this.cursor = r.cursor; }
    }
    this.game.audio.playUI('click', 0.5);
    this.refresh();
  }

  /**
   * Shift-click: with a chest open, inventory ↔ chest; otherwise armor goes to its armor slot, armor slots empty into
   * storage, hotbar ↔ storage.
   */
  _quickMove(space, index) {
    if (index === undefined) { index = space; space = 'inv'; } // the one-argument form (an inventory slot)
    const inv = this.inventory;
    if (space === 'chest') {
      const stack = this.chest.get(index);
      if (!stack) return;
      const left = inv.addItem(stack.itemId, stack.count);
      this.chest.set(index, left > 0 ? new ItemStack(stack.itemId, left) : null);
      return;
    }
    const stack = inv.get(index);
    if (!stack) return;
    if (this.chest) {
      if (this.isGuest) { this._guestQuickToChest(index, stack); return; }
      const left = this.chest.addItem(stack.itemId, stack.count);
      if (left !== stack.count) { if (left > 0) stack.count = left; else inv.slots[index] = null; inv.changed(); }
      return;
    }
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

  /** Double-click: gather all matching items (hotbar + storage, then the open chest when the host) onto the cursor. */
  _gather() {
    const inv = this.inventory;
    const c = this.cursor;
    for (let i = 0; i < INVENTORY_SIZE && c.count < c.maxStack; i++) {
      const s = inv.get(i);
      if (s && s.canMergeWith(c)) { c.absorb(s); if (s.count <= 0) inv.slots[i] = null; }
    }
    inv.changed();
    if (this.chest && !this.isGuest) {
      for (let i = 0; i < CHEST_SLOTS && c.count < c.maxStack; i++) {
        const s = this.chest.get(i);
        if (s && s.canMergeWith(c)) { c.absorb(s); this.chest.set(i, s.count > 0 ? s : null); }
      }
    }
  }

  /** The hotbar number keys over a chest slot swap it with that hotbar slot (the host; a guest asks the host through an exchange). */
  _swapChestWithHotbar(chestIndex, hb) {
    if (!this.chest) return false;
    if (this.isGuest) return false;
    const a = this.chest.get(chestIndex), b = this.inventory.get(hb);
    this.chest.set(chestIndex, b);
    this.inventory.set(hb, a);
    return true;
  }

  _tryAddDragSlot(space, index) {
    if (space === 'inv' && Inventory.isArmorIndex(index)) return;
    const store = this._store(space);
    if (!store) return;
    const s = store.get(index);
    if (!s || s.canMergeWith(this.cursor)) this.drag.slots.add(slotKey(space, index));
  }

  /** Drag distribution: left = split evenly, right = one per slot; chest slots of a guest go through the host. */
  _distribute(d) {
    const c = this.cursor;
    const keys = [...d.slots];
    const per = d.button === 0 ? Math.floor(c.count / keys.length) : 1;
    if (per <= 0) { this.refresh(); return; }
    const chestOps = [];
    for (const key of keys) {
      if (c.count <= 0) break;
      const [space, idx] = key.split(':'); const i = parseInt(idx, 10);
      const store = this._store(space);
      if (!store) continue;
      if (space === 'chest' && this.isGuest) { const n = Math.min(per, c.count); chestOps.push({ slot: i, n }); c.count -= n; continue; } // reserved until the host answers
      const r = putIntoSlot(store.get(i), c.itemId, Math.min(per, c.count));
      if (r.accepted > 0) { store.set(i, r.slot); c.count -= r.accepted; }
    }
    if (c.count <= 0 && !chestOps.length) this.cursor = null;
    if (chestOps.length) this._guestPutMany(c.itemId, chestOps, c);
    this.game.audio.playUI('click', 0.5);
    this.refresh();
  }

  // ---- A guest's chest: every change goes through the host and applies only on its answer ----

  _guestChestClick(index, button, shift) {
    if (this.pendingOp || !this.chestPos || !this.game.net) return;
    const net = this.game.net, pos = this.chestPos;
    if (button === 0 && shift) {
      this.pendingOp = net.chestOp(pos.x, pos.y, pos.z, { op: 'takeAll', slot: index }).then((ack) => {
        if (ack && ack.ok && ack.stack) { const left = this.inventory.addItem(ack.stack.id, ack.stack.n); if (left > 0) this.game.entities.throwFromPlayer(ack.stack.id, left); }
      }).finally(() => { this.pendingOp = null; this.refresh(); });
      return;
    }
    if (button !== 0 && button !== 2) return;
    const cursor = this.cursor ? this.cursor.serialize() : null;
    this.pendingOp = net.chestOp(pos.x, pos.y, pos.z, { op: 'exchange', slot: index, button, cursor }).then((ack) => {
      if (ack && ack.ok) this.cursor = ack.cursor ? ItemStack.deserialize(ack.cursor) : null;
    }).finally(() => { this.pendingOp = null; this.game.audio.playUI('click', 0.5); this.refresh(); });
  }

  _guestQuickToChest(index, stack) {
    if (this.pendingOp || !this.chestPos || !this.game.net) return;
    const pos = this.chestPos, want = stack.count, id = stack.itemId;
    this.pendingOp = this.game.net.chestOp(pos.x, pos.y, pos.z, { op: 'put', slot: -1, id, n: want }).then((ack) => {
      const n = ack && ack.ok ? Math.min(ack.n | 0, want) : 0;
      if (n > 0) this.inventory.removeFromSlot(index, n);
    }).finally(() => { this.pendingOp = null; this.refresh(); });
  }

  /** Drag-distribute into a guest's chest slots: one put per slot; what the host refuses returns to the cursor. */
  _guestPutMany(itemId, ops, cursorStack) {
    if (!this.chestPos || !this.game.net) { cursorStack.count += ops.reduce((a, o) => a + o.n, 0); return; }
    const pos = this.chestPos;
    const run = async () => {
      for (const o of ops) {
        const ack = await this.game.net.chestOp(pos.x, pos.y, pos.z, { op: 'put', slot: o.slot, id: itemId, n: o.n });
        const n = ack && ack.ok ? Math.min(ack.n | 0, o.n) : 0;
        cursorStack.count += o.n - n;
      }
    };
    this.pendingOp = run().finally(() => { this.pendingOp = null; if (this.cursor && this.cursor.count <= 0) this.cursor = null; this.refresh(); });
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
        const store = this._store(this._space(el));
        const s = store ? store.get(parseInt(el.dataset.index, 10)) : null;
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
    if (this.chest) {
      for (let i = 0; i < CHEST_SLOTS; i++) {
        const stack = this.chest.get(i);
        const key = stack ? `${stack.itemId}:${stack.count}` : '';
        if (key === this.lastChestState[i]) continue;
        this.lastChestState[i] = key;
        const s = this.chestSlotEls[i];
        s.icon.style.backgroundImage = stack ? `url(${this.icons.getIcon(stack.itemId)})` : '';
        s.count.textContent = stack && stack.count > 1 ? String(stack.count) : '';
      }
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

  /**
   * @param {'inventory'|'crafting_table'|'furnace'|'chest'} station which left panel to show
   * @param {import('../items/ChestStorage.js').ChestStorage|null} chest the open chest's storage (station 'chest')
   * @param {{x: number, y: number, z: number}|null} chestPos its block
   */
  open(station = 'inventory', chest = null, chestPos = null) {
    this.visible = true;
    this.station = station;
    this.root.classList.remove('hidden');
    const isChest = station === 'chest' && !!chest;
    this.chest = isChest ? chest : null;
    this.chestPos = isChest ? chestPos : null;
    this.pendingOp = null;
    this.leftPanel.classList.toggle('chest', isChest);
    this.chestPanel.classList.toggle('hidden', !isChest);
    const creative = this.game.player.isCreative && station === 'inventory';
    this.toggle.classList.toggle('hidden', !creative);
    if (isChest) {
      this.catalogPanel.classList.add('hidden');
      this.craftArea.classList.add('hidden');
      this.titleEl.classList.add('hidden');
      this.lastChestState.fill(null);
    } else if (creative) {
      this._buildCatalog();
      this._setCreativeView(this.creativeView);
    } else {
      this.catalogPanel.classList.add('hidden');
      this.craftArea.classList.remove('hidden');
      this.titleEl.classList.remove('hidden');
      this.titleEl.textContent = STATION_TITLES[station] || STATION_TITLES.inventory;
      this.crafting.setStation(station);
    }
    this.lastState.fill(null); // slots emptied while the screen was closed used to keep their old icon
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
    this.chest = null;
    this.chestPos = null;
    this.pendingOp = null;
    this.leftPanel.classList.remove('chest');
    this.chestPanel.classList.add('hidden');
  }

  update() {}
}
