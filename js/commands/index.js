// index.js — the command set: add a file per command and register it here.
import { CommandRegistry } from './CommandRegistry.js';
import { help } from './help.js';
import { set } from './set.js';
import { tick } from './tick.js';
import { locate } from './locate.js';
import { tp } from './tp.js';
import { give } from './give.js';
import { summon } from './summon.js';
import { spawn } from './spawn.js';
import { setspawn } from './setspawn.js';
import { clear } from './clear.js';
import { kill } from './kill.js';
import { seed } from './seed.js';

/** @param {import('../core/Game.js').Game} game */
export function createCommands(game) {
  const reg = new CommandRegistry(game);
  for (const c of [help, set, tick, locate, tp, give, summon, spawn, setspawn, clear, kill, seed]) reg.register(c);
  return reg;
}
