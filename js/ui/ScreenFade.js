// ScreenFade.js — the fade between menu screens (Nov 15 2026): one black #screen-fade overlay above every menu screen,
// normally invisible and click-through. `run(change)` fades to black in FADE_OUT_MS, runs `change()` (the screen switch,
// exactly as it happened instantly before) at black, then fades back in FADE_IN_MS; while it fades the overlay blocks
// clicks, so a button can never be pressed twice. Every step is a timer (transitionend never fires in a hidden tab), and
// each change runs exactly once: changes asked for during a fade-out are queued for the same black moment, a change asked
// for during the fade-in starts a new fade-out from the current opacity (fades never stack). `fadeIn(ms)` is the world
// appearing after the loading screen: black at once, then in, click-through. With fades off (?nofade — the headless
// runner's default — or prefers-reduced-motion) every change runs at once and the overlay never shows.

export const FADE_OUT_MS = 150;
export const FADE_IN_MS = 200;
export const WORLD_FADE_IN_MS = 300;

export class ScreenFade {
  constructor(enabled = true) {
    this.el = document.getElementById('screen-fade');
    this.enabled = !!enabled && !!this.el;
    /** 'idle' | 'out' (to black) | 'black' (running the changes) | 'in' (back) */
    this.phase = 'idle';
    this.pending = [];
    this.timer = null;
  }

  get active() { return this.phase !== 'idle'; }

  /** Switch screens through black: `change` runs once, at black (at once with fades off). */
  run(change) {
    if (!this.enabled) { change(); return; }
    this.pending.push(change);
    if (this.phase === 'out' || this.phase === 'black') return; // already heading to black: it runs there
    this._out();
  }

  /**
   * The world appeared (the loading screen is done): any change still waiting runs first, then `change`, then the overlay
   * goes black at once and fades in over `ms`, click-through. With fades off only the changes run.
   */
  fadeIn(ms = WORLD_FADE_IN_MS, change = null) {
    this._clear();
    this._flush();
    if (change) change();
    if (!this.enabled) return;
    this._in(ms, false);
  }

  /** Run the queued changes now (a screen switch that must not wait, such as an in-world screen): the running fade finishes on its own. */
  flush() { this._flush(); }

  _out() {
    const el = this.el;
    const from = this.phase === 'in' ? this._opacity() : 0;
    this._clear();
    this.phase = 'out';
    el.classList.add('fading');
    el.style.transition = 'none'; el.style.opacity = String(from); void el.offsetWidth;
    const ms = Math.max(1, Math.round(FADE_OUT_MS * (1 - from)));
    el.style.transition = `opacity ${ms}ms linear`; el.style.opacity = '1';
    this.timer = setTimeout(() => this._black(), ms + 20);
  }

  _black() {
    this.timer = null;
    this.phase = 'black';
    this._flush();
    this._in(FADE_IN_MS, true);
  }

  /** Run every queued change once (a change may queue another: that one runs now too). */
  _flush() {
    for (let guard = 0; this.pending.length && guard < 16; guard++) {
      const list = this.pending; this.pending = [];
      for (const c of list) { try { c(); } catch (e) { console.error('ScreenFade: a screen change failed', e); } }
    }
  }

  _in(ms, block) {
    const el = this.el;
    this.phase = 'in';
    el.classList.toggle('fading', !!block);
    el.style.transition = 'none'; el.style.opacity = '1'; void el.offsetWidth;
    el.style.transition = `opacity ${ms}ms linear`; el.style.opacity = '0';
    this.timer = setTimeout(() => { this.timer = null; this.phase = 'idle'; el.classList.remove('fading'); el.style.transition = ''; el.style.opacity = ''; }, ms + 20);
  }

  _opacity() { const v = parseFloat(getComputedStyle(this.el).opacity); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }
  _clear() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
