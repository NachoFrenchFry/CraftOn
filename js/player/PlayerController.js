// PlayerController.js — turns keyboard/mouse input into look angles and a movement intent. Crouch is held by default or
// toggled (the Crouch mode option): a toggled crouch ends when the player starts flying or swimming, opens a menu or dies.

import { clamp } from '../utils/MathUtils.js';

const MAX_PITCH = 89.9 * Math.PI / 180;
const SENSITIVITY_SCALE = 0.0022;

export class PlayerController {
  /**
   * @param {import('./Player.js').Player} player
   * @param {import('../input/InputManager.js').InputManager} input
   * @param {import('../input/ActionMap.js').ActionMap} actions
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(player, input, actions, settings) {
    this.player = player;
    this.input = input;
    this.actions = actions;
    this.settings = settings;
    this.enabled = true;
    this._delta = { x: 0, y: 0 };
    this.sprintLatched = false;
    /** Toggle crouch: on until the key is pressed again (or flight, swimming, a menu or death ends it). */
    this.sneakLatched = false;
  }

  /** Apply mouse look (called once per frame). */
  updateLook() {
    if (!this.enabled || !this.input.pointerLocked) return;
    const d = this.input.consumeMouseDelta(this._delta);
    if (d.x === 0 && d.y === 0) return;
    const sens = this.settings.get('mouseSensitivity') * SENSITIVITY_SCALE;
    const invert = this.settings.get('invertY') ? -1 : 1;
    const p = this.player;
    p.yaw -= d.x * sens;
    p.pitch -= d.y * sens * invert;
    p.pitch = clamp(p.pitch, -MAX_PITCH, MAX_PITCH);
    if (p.yaw > Math.PI) p.yaw -= Math.PI * 2;
    if (p.yaw < -Math.PI) p.yaw += Math.PI * 2;
  }

  /** Crouch intent: the held key, or in Toggle mode a latch flipped by each press (held while flying or swimming). */
  _sneak(a, p) {
    if (this.settings.get('crouchMode') !== 'toggle' || p.flying || p.swimming || p.dead) { this.sneakLatched = false; return a.isActive('sneak'); }
    if (a.wasPressed('sneak')) this.sneakLatched = !this.sneakLatched;
    return this.sneakLatched;
  }

  /** Fill the player's movement intent for the next physics step (called per frame). */
  updateIntent() {
    const p = this.player;
    const intent = p.intent;
    if (!this.enabled) {
      // Input suspended (inventory open, pointer unlocked): stop moving but keep the current pose.
      intent.forward = 0; intent.strafe = 0; intent.jump = false; intent.sneak = false; intent.sprint = false;
      intent.up = false; intent.down = false; intent.holdPose = true;
      this.sneakLatched = false; // a menu ends a toggled crouch
      return;
    }
    intent.holdPose = false;
    const a = this.actions;
    let forward = 0, strafe = 0;
    if (a.isActive('forward')) forward += 1;
    if (a.isActive('back')) forward -= 1;
    if (a.isActive('left')) strafe -= 1;
    if (a.isActive('right')) strafe += 1;
    const doubleForward = a.wasDoubleTapped('forward');
    const doubleJump = a.wasDoubleTapped('jump');
    if (doubleForward && forward > 0) this.sprintLatched = true;
    if (forward <= 0) this.sprintLatched = false;
    const sprintKey = a.isActive('sprint');
    intent.forward = forward;
    intent.strafe = strafe;
    intent.jump = a.isActive('jump');
    intent.sneak = this._sneak(a, p);
    intent.sprint = (sprintKey || this.sprintLatched) && forward > 0 && !intent.sneak;
    intent.up = intent.jump;
    intent.down = intent.sneak;
    // Toggle on the rising edge only: the double-tap flag lives for a whole frame, which may run several
    // fixed steps (timer-driven loop, low FPS), and each step must not flip flight again.
    if (doubleJump && !this._doubleJumpLatched && p.isCreative) {
      p.flying = !p.flying;
      if (p.flying) p.velocity.y = 0;
    }
    this._doubleJumpLatched = doubleJump;
    if (p.isSpectator) p.flying = true;       // spectators always fly (and pass through blocks)
    else if (!p.isCreative) p.flying = false;
  }
}
