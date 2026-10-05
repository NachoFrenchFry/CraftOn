// InputManager.js — keyboard/mouse state, pointer lock handling, wheel, per-frame edge detection and
// a capture mode used by the Controls screen to record the next key or mouse button.

const MAX_MOUSE_DELTA = 300; // clamp Chrome pointer-lock spikes
const RELOCK_COOLDOWN_MS = 1100;
const DOUBLE_TAP_MS = 300;

export class InputManager {
  /**
   * @param {HTMLElement} element canvas that receives pointer lock
   * @param {import('../core/EventBus.js').EventBus} events
   */
  constructor(element, events) {
    this.element = element;
    this.events = events;
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    /** Codes pressed twice within DOUBLE_TAP_MS (cleared each frame). */
    this.doubleTapped = new Set();
    this._lastPressTime = new Map();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.pointerLocked = false;
    this.wantPointerLock = false;
    this.lastUnlockTime = -Infinity;
    this.lockFailed = false;
    this.mouseX = 0;
    this.mouseY = 0;
    /** When true keyboard game input is ignored (text field focused). */
    this.textInputActive = false;
    /** Decides which keys get preventDefault (set by Game from the KeyBindingStore). */
    this.shouldPreventDefault = () => false;
    /** While set, the next key / mouse button press is delivered here instead of the game. */
    this.captureCallback = null;
    this._bind();
  }

  /** Record the next key or mouse button press: callback(code) or callback(null) when cancelled by Esc. */
  beginCapture(callback) { this.captureCallback = callback; }
  cancelCapture() { this.captureCallback = null; }
  get capturing() { return this.captureCallback !== null; }

  _bind() {
    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
    window.addEventListener('blur', () => this.clearAll());
    document.addEventListener('mousedown', (e) => this._onMouse(e, true));
    document.addEventListener('mouseup', (e) => this._onMouse(e, false));
    document.addEventListener('mousemove', (e) => this._onMouseMove(e));
    document.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => this._onLockChange());
    document.addEventListener('pointerlockerror', () => this._onLockError());
  }

  _onKey(e, isDown) {
    const target = e.target;
    const isText = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
    if (isText) return;
    const code = e.code;
    if (this.captureCallback) {
      e.preventDefault();
      if (!isDown) return;
      const cb = this.captureCallback;
      this.captureCallback = null;
      cb(code === 'Escape' ? null : code);
      return;
    }
    if (this.shouldPreventDefault(code)) e.preventDefault();
    if (isDown) {
      if (e.repeat) return;
      this.down.add(code);
      this.pressed.add(code);
      this._trackDoubleTap(code);
      this.events.emit('input:keydown', code, e);
    } else {
      this.down.delete(code);
      this.released.add(code);
      this.events.emit('input:keyup', code, e);
    }
  }

  _onMouse(e, isDown) {
    const code = 'Mouse' + e.button;
    if (this.captureCallback) {
      e.preventDefault();
      if (!isDown) return;
      const cb = this.captureCallback;
      this.captureCallback = null;
      cb(code);
      return;
    }
    if (isDown) {
      if (e.button === 1 || e.button >= 3) e.preventDefault();
      this.down.add(code);
      this.pressed.add(code);
      this._trackDoubleTap(code);
      this.events.emit('input:mousedown', e.button, e);
    } else {
      this.down.delete(code);
      this.released.add(code);
      this.events.emit('input:mouseup', e.button, e);
    }
  }

  _onMouseMove(e) {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    if (!this.pointerLocked) return;
    let dx = e.movementX || 0;
    let dy = e.movementY || 0;
    if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  _onWheel(e) {
    if (this.pointerLocked) e.preventDefault();
    this.wheelDelta += Math.sign(e.deltaY);
    this.events.emit('input:wheel', Math.sign(e.deltaY), e);
  }

  _onLockChange() {
    const locked = document.pointerLockElement === this.element;
    const was = this.pointerLocked;
    this.pointerLocked = locked;
    if (was && !locked) {
      this.lastUnlockTime = performance.now();
      this.clearAll();
    }
    this.events.emit('input:pointerlock', locked);
  }

  _onLockError() {
    this.lockFailed = true;
    this.events.emit('input:pointerlockfailed');
  }

  /** Request pointer lock; handles the ~1 s browser cooldown gracefully. */
  requestPointerLock() {
    if (this.pointerLocked) return;
    if (performance.now() - this.lastUnlockTime < RELOCK_COOLDOWN_MS) {
      this.events.emit('input:pointerlockfailed');
      return;
    }
    try {
      const p = this.element.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            const p2 = this.element.requestPointerLock();
            if (p2 && p2.catch) p2.catch(() => this._onLockError());
          } catch (err) { this._onLockError(); }
        });
      }
    } catch (e) {
      try { this.element.requestPointerLock(); } catch (err) { this._onLockError(); }
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Uses event timestamps so detection does not depend on the frame rate; a third press does not re-trigger. */
  _trackDoubleTap(code) {
    const now = performance.now();
    const last = this._lastPressTime.get(code) ?? -Infinity;
    if (now - last < DOUBLE_TAP_MS) {
      this.doubleTapped.add(code);
      this._lastPressTime.set(code, -Infinity);
    } else {
      this._lastPressTime.set(code, now);
    }
  }

  isDown(code) { return !this.textInputActive && this.down.has(code); }
  wasDoubleTapped(code) { return !this.textInputActive && this.doubleTapped.has(code); }
  wasPressed(code) { return !this.textInputActive && this.pressed.has(code); }
  wasReleased(code) { return this.released.has(code); }

  /** Read and reset the accumulated mouse delta. */
  consumeMouseDelta(out) {
    out.x = this.mouseDX;
    out.y = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return out;
  }

  consumeWheel() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  /** Call at the end of every frame to clear edge state. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.doubleTapped.clear();
  }

  clearAll() {
    this.down.clear();
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
