// KeyBindings.js — DEFAULT key bindings and the list of bindable actions (label, group). The live
// bindings are managed by core/KeyBindingStore.js (saved in localStorage) and read by input/ActionMap.js.
// Codes are KeyboardEvent.code values or 'Mouse0'..'Mouse4' for mouse buttons.

export const ACTION_GROUPS = Object.freeze(['Movement', 'Gameplay', 'Inventory', 'Hotbar', 'Misc']);

/** Every bindable action, in the order the Controls screen lists them. */
export const ACTIONS = Object.freeze([
  { id: 'forward', label: 'Walk Forward', group: 'Movement', default: 'KeyW' },
  { id: 'back', label: 'Walk Backward', group: 'Movement', default: 'KeyS' },
  { id: 'left', label: 'Strafe Left', group: 'Movement', default: 'KeyA' },
  { id: 'right', label: 'Strafe Right', group: 'Movement', default: 'KeyD' },
  { id: 'jump', label: 'Jump / Swim Up / Fly Up', group: 'Movement', default: 'Space' },
  { id: 'sneak', label: 'Sneak / Fly Down', group: 'Movement', default: 'ShiftLeft' },
  { id: 'sprint', label: 'Sprint (hold)', group: 'Movement', default: 'ControlLeft' },
  { id: 'attack', label: 'Break Block', group: 'Gameplay', default: 'Mouse0' },
  { id: 'use', label: 'Place Block', group: 'Gameplay', default: 'Mouse2' },
  { id: 'pick', label: 'Pick Block', group: 'Gameplay', default: 'Mouse1' },
  { id: 'drop', label: 'Drop Item (Sprint + Drop = whole stack)', group: 'Gameplay', default: 'KeyQ' },
  { id: 'perspective', label: 'Toggle Perspective', group: 'Gameplay', default: 'KeyP' },
  { id: 'inventory', label: 'Open / Close Inventory', group: 'Inventory', default: 'KeyE' },
  { id: 'hotbar1', label: 'Hotbar Slot 1', group: 'Hotbar', default: 'Digit1' },
  { id: 'hotbar2', label: 'Hotbar Slot 2', group: 'Hotbar', default: 'Digit2' },
  { id: 'hotbar3', label: 'Hotbar Slot 3', group: 'Hotbar', default: 'Digit3' },
  { id: 'hotbar4', label: 'Hotbar Slot 4', group: 'Hotbar', default: 'Digit4' },
  { id: 'hotbar5', label: 'Hotbar Slot 5', group: 'Hotbar', default: 'Digit5' },
  { id: 'hotbar6', label: 'Hotbar Slot 6', group: 'Hotbar', default: 'Digit6' },
  { id: 'hotbar7', label: 'Hotbar Slot 7', group: 'Hotbar', default: 'Digit7' },
  { id: 'hotbar8', label: 'Hotbar Slot 8', group: 'Hotbar', default: 'Digit8' },
  { id: 'hotbar9', label: 'Hotbar Slot 9', group: 'Hotbar', default: 'Digit9' },
  { id: 'debug', label: 'Debug Overlay', group: 'Misc', default: 'F3' },
  { id: 'toggleGameMode', label: 'Toggle Survival / Creative', group: 'Misc', default: 'F4' },
  { id: 'atlasDebug', label: 'Texture Atlas View', group: 'Misc', default: 'F7' },
]);

/** action id → default code. */
export const DEFAULT_BINDINGS = Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a.id, a.default])));

/** Esc is reserved for pause / closing screens and can never be bound. The mouse wheel is hardwired to the hotbar. */
export const PAUSE_CODE = 'Escape';
export const RESERVED_CODES = Object.freeze(new Set([PAUSE_CODE]));

/** Keys whose browser default is always suppressed while playing, in addition to every bound key. */
export const ALWAYS_PREVENT_DEFAULT = Object.freeze(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const KEY_NAMES = {
  Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Cmd', MetaRight: 'Right Cmd', Tab: 'Tab', Enter: 'Enter',
  Backspace: 'Backspace', CapsLock: 'Caps Lock', Escape: 'Esc', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
  BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
  Mouse0: 'Left Click', Mouse1: 'Middle Click', Mouse2: 'Right Click', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
};

/** Human-readable name for a key / mouse code. */
export function describeKey(code) {
  if (!code) return 'None';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return 'Numpad ' + m[1];
  if ((m = /^F(\d+)$/.exec(code))) return 'F' + m[1];
  if ((m = /^Mouse(\d+)$/.exec(code))) return 'Mouse ' + (Number(m[1]) + 1);
  return code;
}
