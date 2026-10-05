// LoadingScreen.js — progress screen for Play ("Downloading world…" → "Generating terrain…" → "Almost ready…")
// and Save & Quit ("Saving…", indeterminate bar). Shown the instant the state changes, before any network request.

export class LoadingScreen {
  constructor() {
    this.root = document.getElementById('loading-screen');
    this.bar = document.getElementById('loading-bar');
    this.text = document.getElementById('loading-text');
    this.title = document.getElementById('loading-title');
    this.progress = document.getElementById('loading-progress');
    this.lastPercent = -1;
  }

  /** @param {{ indeterminate?: boolean, keepProgress?: boolean }} [opts] indeterminate = animated bar with no percentage (saving) */
  show(title = 'Generating terrain…', opts = {}) {
    this.title.textContent = title;
    this.progress.classList.toggle('indeterminate', !!opts.indeterminate);
    if (opts.indeterminate) { this.lastPercent = -1; this.text.textContent = ''; }
    else if (!opts.keepProgress) this.setProgress(0);
    this.root.classList.remove('hidden');
  }

  hide() { this.root.classList.add('hidden'); }

  /** Extra line under the bar (e.g. downloaded chunk count); the percentage returns on the next setProgress. */
  setText(text) { this.text.textContent = text; this.lastPercent = -1; }

  setProgress(fraction) {
    this.progress.classList.remove('indeterminate');
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    if (pct === this.lastPercent) return;
    this.lastPercent = pct;
    this.bar.style.width = `${pct}%`;
    this.text.textContent = `${pct}%`;
  }
}
