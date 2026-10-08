// UIManager.js — creates every screen, shows/hides them per game state and coordinates pointer lock.

import { HUD } from './HUD.js';
import { InventoryScreen } from './InventoryScreen.js';
import { MainMenu } from './MainMenu.js';
import { OptionsMenu } from './OptionsMenu.js';
import { ControlsMenu } from './ControlsMenu.js';
import { LoadingScreen } from './LoadingScreen.js';
import { PauseMenu } from './PauseMenu.js';
import { DebugOverlay } from './DebugOverlay.js';
import { AccountScreen } from './AccountScreen.js';
import { MultiplayerMenu } from './MultiplayerMenu.js';
import { ServerSettingsMenu } from './ServerSettingsMenu.js';
import { DeathScreen } from './DeathScreen.js';
import { ShadersMenu } from './ShadersMenu.js';
import { State } from '../core/GameState.js';

export class UIManager {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.atlasView = document.getElementById('atlas-view');
    this.atlasVisible = false;
  }

  /** Build screens (after the atlas and icons exist). */
  init() {
    const game = this.game;
    this.controls = new ControlsMenu(game);
    this.shaders = new ShadersMenu(game);
    this.options = new OptionsMenu(game);
    this.account = new AccountScreen(game);
    this.mainMenu = new MainMenu(game);
    this.multiplayer = new MultiplayerMenu(game);
    this.loading = new LoadingScreen();
    this.serverSettings = new ServerSettingsMenu(game);
    this.pause = new PauseMenu(game);
    this.hud = new HUD(game);
    this.inventory = new InventoryScreen(game);
    this.debug = new DebugOverlay(game);
    this.death = new DeathScreen(game);
    this.atlasView.addEventListener('click', () => this.toggleAtlasView());
    game.events.on('state:changed', (state) => this._onState(state));
    game.events.on('input:pointerlock', (locked) => this._onPointerLock(locked));
    game.events.on('input:pointerlockfailed', () => this.hud.setPointerHint(true));
    // Any click on a menu button plays the click sound through the button itself; hover ticks:
    document.querySelectorAll('.mc-button').forEach((b) => b.addEventListener('mouseenter', () => game.audio.playUI('hover', 0.4)));
    this._onState(game.state.current);
  }

  _onState(state) {
    if (state !== State.BOOT) this.game.bootScreen.hide(); // the static boot screen gives way to the first real screen
    const inWorld = state === State.PLAYING || state === State.PAUSED || state === State.INVENTORY || state === State.DEAD;
    if (inWorld) this.hud.show(); else this.hud.hide();
    this.options.root.classList.toggle('in-world', inWorld);
    this.shaders.root.classList.toggle('in-world', inWorld);
    this.controls.root.classList.toggle('in-world', inWorld);
    this.mainMenu.hide();
    this.mainMenu.hideWorlds();
    this.multiplayer.hideAll(state === State.KICKED);
    if (state === State.KICKED) this.multiplayer.showKicked(); else this.multiplayer.hideKicked();
    if (state === State.ACCOUNT) this.account.show(); else this.account.hide();
    if (state === State.MENU) { this.mainMenu.show(); this.hud.setPointerHint(false); }
    if (state === State.LOADING) this.loading.show(); else this.loading.hide();
    if (state === State.PAUSED) this.pause.show(); else this.pause.hide();
    if (state === State.DEAD) this.death.show(this.game.health.deathCause); else this.death.hide();
    if (state !== State.INVENTORY && this.inventory.visible) this.inventory.close();
    if (state === State.PLAYING) this.hud.setPointerHint(!this.game.input.pointerLocked);
    else this.hud.setPointerHint(false);
  }

  _onPointerLock(locked) {
    const game = this.game;
    if (locked) {
      this.hud.setPointerHint(false);
      return;
    }
    if (game.state.is(State.PLAYING) && !game.expectUnlock) game.pause();
    game.expectUnlock = false;
  }

  toggleAtlasView() {
    this.atlasVisible = !this.atlasVisible;
    this.atlasView.classList.toggle('hidden', !this.atlasVisible);
    if (this.atlasVisible) {
      this.atlasView.innerHTML = '';
      const label = document.createElement('div');
      label.textContent = 'Texture atlas (click to close)';
      this.atlasView.append(label, this.game.atlas.buildDebugCanvas(3));
      if (this.game.input.pointerLocked) { this.game.expectUnlock = true; this.game.input.exitPointerLock(); }
    } else if (this.game.state.is(State.PLAYING)) {
      this.game.requestPointerLock();
    }
  }

  update(dt) {
    this.shaders.update(dt);
    this.hud.update(dt);
    this.inventory.update(dt);
    this.debug.update(dt);
  }
}
