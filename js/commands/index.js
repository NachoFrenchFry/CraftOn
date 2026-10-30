// index.js — the command set: add a file per command and register it here.
import { CommandRegistry } from './CommandRegistry.js';
import { help } from './help.js';
import { set } from './set.js';
import { tick } from './tick.js';
import { locate } from './locate.js';

/** @param {import('../core/Game.js').Game} game */
export function createCommands(game) {
  return new CommandRegistry(game).register(help).register(set).register(tick).register(locate);
}
