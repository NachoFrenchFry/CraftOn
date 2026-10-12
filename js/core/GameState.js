// GameState.js — the high level state machine: BOOT / ACCOUNT / MENU / LOADING / PLAYING / PAUSED / INVENTORY / KICKED.

export const State = Object.freeze({
  BOOT: 'BOOT',         // the boot screen while textures, sounds and the session load (Update #7)
  ACCOUNT: 'ACCOUNT',   // log in / create account (before the main menu)
  KICKED: 'KICKED',     // "Signed in somewhere else" (Update #8): the account was claimed by another tab / device
  MENU: 'MENU',
  LOADING: 'LOADING',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  INVENTORY: 'INVENTORY',
  DEAD: 'DEAD',           // the "You died!" screen (Update #9 §8): the world keeps running, the player waits to respawn
});

export class GameState {
  constructor(events) {
    this.events = events;
    this.current = State.BOOT;
    this.previous = null;
    /** Update #12 §3b: in multiplayer the pause menu is only an overlay — the world keeps running (set by Game). */
    this.overlayPause = false;
  }

  is(state) { return this.current === state; }

  /** True while a world is loaded and being rendered. */
  get inWorld() {
    return this.current === State.PLAYING || this.current === State.PAUSED || this.current === State.INVENTORY || this.current === State.DEAD;
  }

  /** True when physics should tick (playing, inventory open, or dead: the world goes on around the body). */
  get simulating() {
    return this.current === State.PLAYING || this.current === State.INVENTORY || this.current === State.DEAD || (this.current === State.PAUSED && this.overlayPause);
  }

  set(state) {
    if (state === this.current) return;
    this.previous = this.current;
    this.current = state;
    this.events.emit('state:changed', state, this.previous);
  }
}
