// PointerLockController.js — the one owner of the mouse lock (Update #13 §1). Nothing else calls
// requestPointerLock / exitPointerLock. A small state machine, unlocked → requesting → locked, with a pendingRelock
// flag, decides in one place what every unlock meant:
//   'own'        the game let go (a menu, the inventory, the chat, leaving the world) — nothing to do
//   'esc'        the player pressed Esc: the lock was held steadily for more than ESC_HOLD_MS and no other reason applies
//   'unexpected' anything else: a lock lost within ESC_HOLD_MS of getting it, a failed or rejected request, the window
//                losing focus — the lightweight "Click to resume" overlay, never the pause menu
// Only one request is in flight at a time; extra requests are ignored. The `unadjustedMovement` option is tried once and
// dropped for good after the first rejection, and the rejection's retry happens inside the same request, so it can never
// surface as an extra unlock. With `?debuglog` every request, promise result, lock event, Escape key and state change is
// logged with a timestamp. The browser calls go through `driver`, which tests replace with a simulated browser.
const ESC_HOLD_MS = 500;        // a lock held at least this long before an unlock counts as the player's Esc
const COOLDOWN_MS = 1100;       // browsers refuse a new lock for about a second after an Esc exit
const REQUEST_TIMEOUT_MS = 1500; // a request without any lock event by then is treated as failed

/** The real browser: request on the element, exit on the document, read the document's lock state. */
export const domDriver = {
  request(element, options) { return element.requestPointerLock(options); },
  exit() { if (document.pointerLockElement) document.exitPointerLock(); },
  isLocked(element) { return document.pointerLockElement === element; },
};

export class PointerLockController {
  /**
   * @param {HTMLElement} element the canvas that takes the lock
   * @param {import('../core/EventBus.js').EventBus} events emits lock:locked, lock:unlocked (reason), lock:failed
   */
  constructor(element, events) {
    this.element = element;
    this.events = events;
    this.driver = domDriver;
    /** 'unlocked' | 'requesting' | 'locked' */
    this.state = 'unlocked';
    /** Request again on the next key press (not Esc) or click: a refused request, or Esc closed a menu (no activation). */
    this.pendingRelock = false;
    /** false after release(): a lock the browser grants after that (a request already sent) is exited again. */
    this.wanted = false;
    this.unadjustedSupported = true;
    this.lockedSince = 0;
    this.cooldownUntil = 0;
    /** Set by release(): the coming unlock is the game's own. */
    this.ownRelease = false;
    this.lastEscAt = -Infinity;
    this.lastBlurAt = -Infinity;
    this.requestSource = null;
    this.requestedAt = 0;
    this.requestTimer = 0;
    this.debug = false;
    this.history = [];
    this._bound = false;
    /** Counters for tests and the debug log. */
    this.stats = { requests: 0, ignored: 0, locks: 0, unlocks: { own: 0, esc: 0, unexpected: 0 }, failures: 0 };
    this.bind();
  }

  get locked() { return this.state === 'locked'; }
  now() { return performance.now(); }

  bind() {
    if (this._bound || typeof document === 'undefined') return;
    this._bound = true;
    document.addEventListener('pointerlockchange', () => this.onLockChange(this.driver.isLocked(this.element)));
    document.addEventListener('pointerlockerror', () => this.onLockError('pointerlockerror event'));
    window.addEventListener('blur', () => { this.lastBlurAt = this.now(); this.log('window blur'); });
  }

  log(message) {
    if (this.history.length > 200) this.history.shift();
    this.history.push({ t: Math.round(this.now()), message, state: this.state });
    if (this.debug) console.info(`[lock ${this.now().toFixed(0)} ms] ${message} (state ${this.state})`);
  }

  _setState(state) {
    if (state === this.state) return;
    this.log(`state ${this.state} → ${state}`);
    this.state = state;
  }

  /** The game wants the mouse. `source` names the caller for the log ('resume', 'overlay', 'canvas', 'key', 'respawn'…). */
  request(source = 'game') {
    const now = this.now();
    this.wanted = true;
    if (this.state === 'locked') { this.log(`request from ${source} ignored: already locked`); return 'locked'; }
    if (this.state === 'requesting') { this.stats.ignored++; this.log(`request from ${source} ignored: one is in flight (${this.requestSource})`); return 'in-flight'; }
    if (now < this.cooldownUntil) { this.pendingRelock = true; this.log(`request from ${source} deferred: browser cooldown for ${Math.round(this.cooldownUntil - now)} ms more`); this.events.emit('lock:failed', 'cooldown'); return 'cooldown'; }
    this.stats.requests++;
    this.requestSource = source;
    this.requestedAt = now;
    this.pendingRelock = true; // stays set until the lock arrives, so a refusal is retried on the next key press / click
    this._setState('requesting');
    this._armTimeout();
    this._call({ unadjustedMovement: this.unadjustedSupported });
    return 'requested';
  }

  _armTimeout() {
    clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(() => { if (this.state === 'requesting') this.onLockError('no lock event within the timeout'); }, REQUEST_TIMEOUT_MS);
  }

  /** One browser call. A rejected unadjustedMovement request is retried without the option inside the same request. */
  _call(options) {
    const useUnadjusted = !!options.unadjustedMovement;
    this.log(`requestPointerLock(${useUnadjusted ? '{ unadjustedMovement: true }' : 'no options'}) from ${this.requestSource}`);
    let p;
    try { p = this.driver.request(this.element, useUnadjusted ? { unadjustedMovement: true } : undefined); }
    catch (e) { this._onCallFailed(useUnadjusted, e); return; }
    if (p && typeof p.then === 'function') {
      p.then(() => this.log(`promise resolved (${useUnadjusted ? 'unadjusted' : 'plain'})`)).catch((e) => this._onCallFailed(useUnadjusted, e));
    }
  }

  _onCallFailed(useUnadjusted, error) {
    const text = error && (error.message || error.name) ? `${error.name || ''} ${error.message || ''}`.trim() : String(error);
    this.log(`promise rejected (${useUnadjusted ? 'unadjusted' : 'plain'}): ${text}`);
    if (this.state !== 'requesting') return; // the lock arrived anyway, or the request already failed
    if (useUnadjusted) {
      // Known on some macOS / Chrome setups: remember, and retry the same request without the option.
      this.unadjustedSupported = false;
      this.log('unadjustedMovement is not supported here: dropping the option for good, retrying');
      this._armTimeout();
      this._call({ unadjustedMovement: false });
      return;
    }
    this.onLockError(text);
  }

  /** The game lets go of the mouse (menus, inventory, chat, leaving the world). Never a cooldown, never the pause menu. */
  release(source = 'game') {
    clearTimeout(this.requestTimer);
    this.pendingRelock = false;
    this.wanted = false;
    if (this.state === 'locked' || this.driver.isLocked(this.element)) {
      this.ownRelease = true;
      this.log(`release from ${source}`);
      this.driver.exit();
    } else {
      if (this.state === 'requesting') this.log(`release from ${source} while requesting: the request is dropped`);
      this._setState('unlocked');
    }
  }

  /** Esc closed a menu (no user activation): ask again on the next key press or click. */
  relockOnNextInput() { this.wanted = true; if (this.state !== 'locked') { this.pendingRelock = true; this.log('re-lock on the next key press or click'); } }

  /** The game no longer wants the mouse at all. */
  cancelRelock() { this.pendingRelock = false; this.wanted = false; }

  /** Any key press (not Esc) or mouse button press is user activation: a pending request goes through now. */
  onUserInput(code) {
    if (code === 'Escape') { this.lastEscAt = this.now(); this.log('Escape keydown'); return; }
    if (this.pendingRelock && this.state === 'unlocked') this.request(`input:${code}`);
  }

  onKeyUp(code) { if (code === 'Escape') this.log('Escape keyup'); }

  /** The browser's pointerlockchange: locked or unlocked (tests call it directly). */
  onLockChange(locked) {
    const now = this.now();
    clearTimeout(this.requestTimer);
    if (locked) {
      const latency = this.state === 'requesting' ? Math.round(now - this.requestedAt) : null;
      this.log(`pointerlockchange: locked${latency !== null ? ` (${latency} ms after the request from ${this.requestSource})` : ' (not requested by us)'}`);
      this.stats.locks++;
      this.lockedSince = now;
      this.pendingRelock = false;
      this.ownRelease = false;
      this._setState('locked');
      if (!this.wanted) {
        // The game released the mouse (a screen opened) while this request was still in flight: the browser granted it
        // anyway, so give it straight back; the unlock that follows is the game's own (no cooldown, no menu).
        this.log('locked after a release (a late grant): exiting again');
        this.release('late-grant');
        return;
      }
      this.events.emit('lock:locked');
      this.events.emit('input:pointerlock', true);
      return;
    }
    if (this.state !== 'locked') { this.log('pointerlockchange: unlocked while not locked (ignored)'); this._setState('unlocked'); return; }
    const held = now - this.lockedSince;
    let reason;
    if (this.ownRelease) reason = 'own';
    else if (now - this.lastBlurAt < 300) reason = 'unexpected';
    else if (held > ESC_HOLD_MS) reason = 'esc';
    else reason = 'unexpected';
    this.ownRelease = false;
    this.stats.unlocks[reason]++;
    this.log(`pointerlockchange: unlocked after ${Math.round(held)} ms → ${reason}${this.lastEscAt > this.lockedSince ? ' (Escape seen)' : ''}`);
    if (reason !== 'own') this.cooldownUntil = now + COOLDOWN_MS; // the browser refuses a new lock for about a second after a forced exit
    this._setState('unlocked');
    this.events.emit('input:pointerlock', false);
    this.events.emit('lock:unlocked', reason, held);
  }

  /** A request failed (error event, rejected promise, timeout): the overlay, and a retry on the next key press / click. */
  onLockError(why = 'error') {
    clearTimeout(this.requestTimer);
    if (this.state === 'locked') { this.log(`pointerlockerror while locked: ${why} (ignored)`); return; }
    this.stats.failures++;
    this.log(`request failed: ${why}`);
    this._setState('unlocked');
    this.pendingRelock = this.wanted; // a failure after a release must not re-arm the lock for the next key press
    this.events.emit('lock:failed', why);
    this.events.emit('input:pointerlockfailed');
  }
}
