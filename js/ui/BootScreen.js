// BootScreen.js — the very first screen: CraftOn title, a progress bar and the current startup step
// ("Loading textures…", "Signing in…", "Loading your worlds…"). It is plain HTML that is visible before any
// module has loaded, so a slow device sees feedback immediately; main.js updates it and UIManager hides it
// when the account screen or main menu takes over.

export class BootScreen {
  constructor() {
    this.root = document.getElementById('boot-screen');
    this.bar = document.getElementById('boot-bar');
    this.text = document.getElementById('boot-text');
    this.hidden = false;
  }

  /** Show a step name and move the bar (fraction 0..1; omit to keep the current width). */
  setStep(text, fraction = null) {
    if (this.text) this.text.textContent = text;
    if (fraction !== null && this.bar) this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  hide() {
    if (this.hidden || !this.root) return;
    this.hidden = true;
    this.root.classList.add('hidden');
  }

  show() {
    if (!this.root) return;
    this.hidden = false;
    this.root.classList.remove('hidden');
  }
}
