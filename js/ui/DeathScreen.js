// DeathScreen.js — "You died!" with the cause, Respawn (at the world spawn with full health) and Leave World
// (Update #9 §8). Shown by UIManager while the state is DEAD; the world keeps running behind it.
import { causeText } from '../player/Damage.js';

export class DeathScreen {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('death-screen');
    this.causeEl = document.getElementById('death-cause');
    this.leaveButton = document.getElementById('btn-death-leave');
    document.getElementById('btn-respawn').addEventListener('click', () => { game.audio.playUI('click'); game.health.respawn(); });
    this.leaveButton.addEventListener('click', () => { game.audio.playUI('click'); game.saveAndQuit(); });
  }

  show(cause) {
    this.causeEl.textContent = causeText(cause);
    this.leaveButton.textContent = this.game.isGuest ? 'Leave Server' : 'Leave World';
    this.root.classList.remove('hidden');
  }

  hide() { this.root.classList.add('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }
}
