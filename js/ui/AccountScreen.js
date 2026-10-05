// AccountScreen.js — the Log In / Create Account screen shown before the main menu (Update #6). Username
// and password only (no email anywhere), a loading state, friendly error line, Enter submits, and a Retry
// button when the server cannot be reached. Key bindings are ignored while typing.

import { State } from '../core/GameState.js';
import { AccountError } from '../core/Account.js';

export class AccountScreen {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('account-menu');
    this.tabLogin = document.getElementById('acct-tab-login');
    this.tabSignup = document.getElementById('acct-tab-signup');
    this.username = document.getElementById('acct-username');
    this.password = document.getElementById('acct-password');
    this.confirm = document.getElementById('acct-confirm');
    this.confirmLabel = document.getElementById('acct-confirm-label');
    this.submit = document.getElementById('acct-submit');
    this.retry = document.getElementById('acct-retry');
    this.error = document.getElementById('acct-error');
    this.note = document.getElementById('acct-note');
    this.mode = 'login';
    this.busy = false;
    this.tabLogin.addEventListener('click', () => this.setMode('login'));
    this.tabSignup.addEventListener('click', () => this.setMode('signup'));
    this.submit.addEventListener('click', () => this._submit());
    this.retry.addEventListener('click', () => this._submit());
    for (const input of [this.username, this.password, this.confirm]) {
      input.addEventListener('focus', () => { game.input.textInputActive = true; });
      input.addEventListener('blur', () => { game.input.textInputActive = false; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._submit(); } e.stopPropagation(); });
    }
    this.setMode('login');
  }

  setMode(mode) {
    this.mode = mode;
    const signup = mode === 'signup';
    this.tabLogin.classList.toggle('active', !signup);
    this.tabSignup.classList.toggle('active', signup);
    this.confirmLabel.classList.toggle('hidden', !signup);
    this.note.classList.toggle('hidden', !signup);
    this.submit.textContent = signup ? 'Create Account' : 'Log In';
    this._setError('');
  }

  show() {
    this.root.classList.remove('hidden');
    this._setBusy(false);
    this.password.value = '';
    this.confirm.value = '';
    this._setError('');
    setTimeout(() => this.username.focus(), 0);
  }

  hide() {
    this.root.classList.add('hidden');
    if (document.activeElement && this.root.contains(document.activeElement)) document.activeElement.blur();
    this.game.input.textInputActive = false;
  }

  _setError(text, offline = false) {
    this.error.textContent = text;
    this.error.classList.toggle('hidden', !text);
    this.retry.classList.toggle('hidden', !offline);
  }

  _setBusy(busy, label = '') {
    this.busy = busy;
    for (const el of [this.username, this.password, this.confirm, this.submit, this.tabLogin, this.tabSignup]) el.disabled = busy;
    this.submit.classList.toggle('busy', busy);
    if (busy) this.submit.innerHTML = `<span class="spinner"></span>${label}`; // spinner right away; the label is our own text
    else this.submit.textContent = this.mode === 'signup' ? 'Create Account' : 'Log In';
  }

  async _submit() {
    if (this.busy) return;
    this.game.audio.playUI('click');
    this._setError('');
    const username = this.username.value.trim(), password = this.password.value;
    this._setBusy(true, this.mode === 'signup' ? 'Creating account…' : 'Logging in…');
    const r = this.mode === 'signup'
      ? await this.game.account.signUp(username, password, this.confirm.value)
      : await this.game.account.signIn(username, password);
    this._setBusy(false);
    if (!r.ok) { this._setError(r.error, r.error === AccountError.OFFLINE); return; }
    if (this.game.sessionGuard) await this.game.sessionGuard.claim(); // one place per account: this tab takes over
    this.game.prefetchWorlds(); // the world list starts loading the moment the session exists
    this.game.state.set(State.MENU);
  }
}
