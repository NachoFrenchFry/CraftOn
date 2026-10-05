// HUD.js — crosshair, hotbar container, item-name popup, pointer hint and the underwater tint.
// The #status-bars container is intentionally empty (no health/hunger/armor/XP yet).

import { Hotbar } from './Hotbar.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { itemStatLines } from '../items/Tools.js';

const POPUP_SECONDS = 2;

export class HUD {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('hud');
    this.crosshair = document.getElementById('crosshair');
    this.popup = document.getElementById('item-name-popup');
    this.hint = document.getElementById('pointer-hint');
    this.underwater = document.getElementById('underwater-overlay');
    this.fpsCounter = document.getElementById('fps-counter');
    this.fpsTimer = 0;
    this._fpsShown = false;
    this.hotbar = new Hotbar(document.getElementById('hotbar'), game.inventory, game.icons, game.events);
    this.popupTimer = 0;
    this._underwaterShown = false;
    this._hintShown = false;
    this._crosshairShown = true;
    game.events.on('inventory:selected', () => this.showItemName());
    game.events.on('inventory:changed', () => this._refreshPopupIfVisible());
    this.hint.addEventListener('click', () => game.requestPointerLock());
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  showItemName() {
    const stack = this.game.inventory.getSelected();
    if (!stack) { this.popup.classList.remove('visible'); this.popupTimer = 0; return; }
    this._setPopup(ItemRegistry.displayName(stack.itemId), itemStatLines(stack.itemId));
  }

  /** Show arbitrary text in the popup (e.g. spectator fly speed). */
  showMessage(text) { this._setPopup(text, []); }

  _setPopup(title, lines) {
    this.popup.textContent = '';
    const name = document.createElement('div');
    name.textContent = title;
    this.popup.appendChild(name);
    for (const line of lines) {
      const el = document.createElement('div');
      el.className = 'popup-stat ' + line.color;
      el.textContent = line.text;
      this.popup.appendChild(el);
    }
    this.popup.classList.add('visible');
    this.popupTimer = POPUP_SECONDS;
  }

  setHotbarVisible(v) { this.hotbar.root.classList.toggle('hidden', !v); }

  /** Small non-blocking notice (e.g. "Couldn't save, retrying…"); sticky toasts stay until hidden. */
  showToast(text, sticky = false) {
    if (!this.toast) this.toast = document.getElementById('toast');
    if (!this.toast) return;
    this.toast.textContent = text;
    this.toast.classList.remove('hidden');
    this.toastTimer = sticky ? Infinity : 4;
  }

  hideToast() {
    if (!this.toast) this.toast = document.getElementById('toast');
    if (this.toast) this.toast.classList.add('hidden');
    this.toastTimer = 0;
  }

  _refreshPopupIfVisible() {
    if (this.popupTimer > 0 && !this.game.player.isSpectator) {
      const stack = this.game.inventory.getSelected();
      if (!stack) { this.popup.classList.remove('visible'); this.popupTimer = 0; }
    }
  }

  setCrosshairVisible(v) {
    if (v === this._crosshairShown) return;
    this._crosshairShown = v;
    this.crosshair.classList.toggle('hidden', !v);
  }

  setPointerHint(v) {
    if (v === this._hintShown) return;
    this._hintShown = v;
    this.hint.classList.toggle('hidden', !v);
  }

  update(dt) {
    if (this.toastTimer > 0 && this.toastTimer !== Infinity) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.hideToast(); }
    if (this.popupTimer > 0) {
      this.popupTimer -= dt;
      if (this.popupTimer <= 0) this.popup.classList.remove('visible');
    }
    const showFps = this.game.settings.get('showFps');
    if (showFps !== this._fpsShown) { this._fpsShown = showFps; this.fpsCounter.classList.toggle('hidden', !showFps); }
    if (showFps) {
      this.fpsTimer -= dt;
      if (this.fpsTimer <= 0) { this.fpsTimer = 0.25; this.fpsCounter.textContent = `${this.game.loop.fps} fps`; }
    }
    const uw = this.game.player.headInWater;
    if (uw !== this._underwaterShown) {
      this._underwaterShown = uw;
      this.underwater.classList.toggle('hidden', !uw);
    }
  }
}
