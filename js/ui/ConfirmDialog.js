// ConfirmDialog.js — the in-game confirm box (Nov 11 2026): one sentence and two buttons with their own labels ("Remove the
// badge" / "Cancel", "Lock it" / "Cancel"), above every other screen; `ask()` resolves true or false. Esc cancels. Used
// wherever an action would take a world's Pure Survival badge (the pause menu's Game Mode button, the toggleGameMode key,
// the mode selects and the cheats permission in World / Server Settings) and when a world is created with the game mode lock.
export class ConfirmDialog {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('confirm-dialog');
    this.text = document.getElementById('confirm-text');
    this.okButton = document.getElementById('btn-confirm-ok');
    this.cancelButton = document.getElementById('btn-confirm-cancel');
    this.pending = null;
    this.okButton.addEventListener('click', () => { game.audio.playUI('click'); this._answer(true); });
    this.cancelButton.addEventListener('click', () => { game.audio.playUI('click'); this._answer(false); });
    document.addEventListener('keydown', (e) => { if (this.isOpen && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); this._answer(false); } }, true);
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  /**
   * Show the box; resolves true for the first button, false for Cancel (or Esc). A box already open is cancelled first.
   * @param {string} text
   * @param {{ ok?: string, cancel?: string, danger?: boolean }} [opts]
   */
  ask(text, { ok = 'OK', cancel = 'Cancel', danger = true } = {}) {
    if (this.pending) this._answer(false);
    this.text.textContent = text;
    this.okButton.textContent = ok;
    this.cancelButton.textContent = cancel;
    this.okButton.classList.toggle('danger', !!danger);
    this.root.classList.remove('hidden');
    this.game.input.textInputActive = true; // game keys stay out while the box is up
    return new Promise((resolve) => { this.pending = resolve; this.cancelButton.focus(); });
  }

  _answer(value) {
    const resolve = this.pending;
    this.pending = null;
    this.root.classList.add('hidden');
    this.game.input.textInputActive = false;
    if (resolve) resolve(value);
  }
}
