// HUD.js — crosshair, hotbar container, the health bar (Update #9 §8), item-name popup, pointer hint, the
// underwater tint and the red hurt vignette.

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
    this.lavaOverlay = document.getElementById('lava-overlay');
    this.fireOverlay = document.getElementById('fire-overlay');
    this._lavaShown = false; this._fireShown = false;
    this.fpsCounter = document.getElementById('fps-counter');
    this.healthBar = document.getElementById('health-bar');
    this.hbFill = this.healthBar.querySelector('.hb-fill');
    this.hbChip = this.healthBar.querySelector('.hb-chip');
    this.hbText = this.healthBar.querySelector('.hb-text');
    this.hurtOverlay = document.getElementById('hurt-overlay');
    this._hbShown = null; this._hbHealth = -1; this._hbLow = false; this._hurtShown = false; this._chipTimer = null;
    game.events.on('player:damaged', () => { this.healthBar.classList.remove('hit'); void this.healthBar.offsetWidth; this.healthBar.classList.add('hit'); });
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

  /** The health bar: red fill, white "recent damage" chip that shrinks after a hit, pulse under 20, hidden outside Survival. */
  _updateHealth() {
    const g = this.game, p = g.player, hs = g.health;
    const shown = !!hs && hs.active && g.state.inWorld;
    if (shown !== this._hbShown) { this._hbShown = shown; this.healthBar.classList.toggle('hidden', !shown); }
    if (shown && p.health !== this._hbHealth) {
      const prev = this._hbHealth;
      this._hbHealth = p.health;
      const pct = Math.max(0, Math.min(100, p.health / p.maxHealth * 100));
      this.hbFill.style.width = `${pct}%`;
      this.hbText.textContent = `${Math.round(p.health)} / ${p.maxHealth}`;
      if (prev < 0 || p.health > prev) this.hbChip.style.width = `${pct}%`; // healing: the chip follows at once
      else this.hbChip.style.width = `${pct}%`; // damage: the CSS transition (delayed) shrinks it from the old width
      const low = p.health < 20;
      if (low !== this._hbLow) { this._hbLow = low; this.healthBar.classList.toggle('low', low); }
    }
    const hurt = !!hs && hs.hurtFlash > 0 && shown;
    if (hurt !== this._hurtShown) { this._hurtShown = hurt; this.hurtOverlay.classList.toggle('hidden', !hurt); }
    if (hurt) this.hurtOverlay.style.opacity = String(Math.min(1, hs.hurtFlash / 0.35));
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
    this._updateHealth();
    const uw = this.game.player.headInWater;
    if (uw !== this._underwaterShown) {
      this._underwaterShown = uw;
      this.underwater.classList.toggle('hidden', !uw);
    }
    // Update #11: orange inside lava; flames on the screen edges while on fire (first person only; third person shows the particles).
    const lv = !!this.game.player.headInLava;
    if (lv !== this._lavaShown) { this._lavaShown = lv; this.lavaOverlay.classList.toggle('hidden', !lv); }
    const fire = !!this.game.player.onFire && !this.game.player.dead && this.game.cameraController.isFirstPerson;
    if (fire !== this._fireShown) { this._fireShown = fire; this.fireOverlay.classList.toggle('hidden', !fire); }
  }
}
