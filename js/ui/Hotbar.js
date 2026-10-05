// Hotbar.js — the 9 HUD hotbar slots: icons, counts and the selection frame.

import { HOTBAR_SIZE } from '../items/Inventory.js';

export class Hotbar {
  /**
   * @param {HTMLElement} root
   * @param {import('../items/Inventory.js').Inventory} inventory
   * @param {import('../rendering/BlockIconRenderer.js').BlockIconRenderer} icons
   * @param {import('../core/EventBus.js').EventBus} events
   */
  constructor(root, inventory, icons, events) {
    this.root = root;
    this.inventory = inventory;
    this.icons = icons;
    this.slots = [];
    this.lastState = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'hotbar-slot';
      const icon = document.createElement('div');
      icon.className = 'slot-icon';
      const count = document.createElement('div');
      count.className = 'slot-count';
      el.append(icon, count);
      root.appendChild(el);
      this.slots.push({ el, icon, count });
      this.lastState.push(null); // null = never drawn (an empty slot's key is '')
    }
    events.on('inventory:changed', () => this.refresh());
    events.on('inventory:selected', () => this.refreshSelection());
    this.refresh();
    this.refreshSelection();
  }

  refresh() {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const stack = this.inventory.get(i);
      const key = stack ? `${stack.itemId}:${stack.count}` : '';
      if (key === this.lastState[i]) continue;
      this.lastState[i] = key;
      const s = this.slots[i];
      if (stack) {
        s.icon.style.backgroundImage = `url(${this.icons.getIcon(stack.itemId)})`;
        s.count.textContent = stack.count > 1 ? String(stack.count) : '';
      } else {
        s.icon.style.backgroundImage = '';
        s.count.textContent = '';
      }
    }
  }

  refreshSelection() {
    const sel = this.inventory.selectedIndex;
    this.slots.forEach((s, i) => s.el.classList.toggle('selected', i === sel));
  }
}
