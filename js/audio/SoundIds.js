// SoundIds.js — the sound ids the game plays: one folder per sound under audio/, e.g. "breaking/stone",
// "player/hurt", "mobs/cow/ambient", "ui/click". The code still asks for the old dotted names in a few places
// ("stone.break", "ui.pop", "mob.cow_hurt"…) and the network relays them, so soundId() maps either form to the folder id.
// The export tool (tools/sound-recipes/) and tools/check-sounds.mjs use the same mapping. Pure, worker-safe.

import { SOUND_GROUP_LIST } from '../blocks/BlockSoundGroups.js';

/** Block material kinds → folders. */
export const KIND_FOLDERS = Object.freeze({ step: 'walking', break: 'breaking', place: 'placing', hit: 'mining' });
export const MOB_TYPES = Object.freeze(['cow', 'pig', 'sheep']);
export const MOB_VOICES = Object.freeze(['ambient', 'hurt', 'death']);
/** Old dotted names that do not follow the generic rules. */
const RENAMES = Object.freeze({
  'ui.pop': 'items/pickup',
  'ui.drop': 'items/drop',
  'ui.inv_open': 'ui/inventory_open',
  'ui.inv_close': 'ui/inventory_close',
  'player.bucket_fill': 'items/bucket_fill',
  'player.bucket_empty': 'items/bucket_empty',
  'lava.sizzle': 'liquids/lava_sizzle',
  'lava.pop': 'liquids/lava_pop',
});

/** Folder id for a sound name: an id with a slash is returned as is; a dotted legacy name is translated. */
export function soundId(name) {
  if (name.includes('/')) return name;
  const renamed = RENAMES[name];
  if (renamed) return renamed;
  const dot = name.indexOf('.');
  if (dot < 0) return name;
  const head = name.slice(0, dot), tail = name.slice(dot + 1);
  const kind = KIND_FOLDERS[tail];
  if (kind && SOUND_GROUP_LIST.includes(head)) return `${kind}/${head}`;
  if (head === 'mob') {
    const us = tail.indexOf('_');
    return us < 0 ? `mobs/${tail}/ambient` : `mobs/${tail.slice(0, us)}/${tail.slice(us + 1)}`;
  }
  return `${head}/${tail}`; // player.*, ui.*, ambient.*
}

/** Every sound id the game can play, with what plays it (the audio/README.md table and the checks are built from this). */
export const SOUND_CATALOG = (() => {
  const list = [];
  const add = (id, when, length, loop = false) => list.push({ id, when, length, loop });
  for (const g of SOUND_GROUP_LIST) {
    add(`walking/${g}`, `a footstep on a ${g} block (the player, other players, mobs)`, '0.1–0.3 s');
    add(`breaking/${g}`, `a ${g} block breaks`, '0.3–0.6 s');
    add(`placing/${g}`, `a ${g} block is placed`, '0.2–0.4 s');
    add(`mining/${g}`, `the chipping while holding the mouse on a ${g} block (every 0.25 s)`, '0.1–0.3 s');
  }
  add('player/jump', 'the player jumps (reserved: the game currently plays a quiet footstep)', '0.1–0.2 s');
  add('player/land', 'the player lands after a fall (reserved: the game plays a pitched-down footstep)', '0.2–0.4 s');
  add('player/hurt', 'the player takes damage', '0.2–0.4 s');
  add('player/death', 'the player dies', '0.5–1 s');
  add('player/crit', 'a critical hit on a mob (with the star burst)', '0.2–0.3 s');
  add('player/eat', 'each chew while eating (every 0.28 s)', '0.1–0.2 s');
  add('player/eat_done', 'eating finished', '0.3–0.5 s');
  add('player/burn', 'reserved for burning (not played yet)', '0.3–0.5 s');
  add('player/splash', 'entering water fast', '0.5–1 s');
  add('player/swim', 'a swim stroke (every 0.6 s while swimming)', '0.3–0.6 s');
  add('player/equip_wood', 'putting on wooden armor', '0.2–0.3 s');
  add('player/equip_metal', 'putting on iron or diamond armor', '0.2–0.4 s');
  add('items/pickup', 'an item is picked up, a spawn egg is used', '0.1–0.2 s');
  add('items/drop', 'an item is thrown (Q)', '0.2–0.3 s');
  add('items/bucket_fill', 'a bucket scoops water or lava', '0.4–0.6 s');
  add('items/bucket_empty', 'a bucket is poured out', '0.5–0.9 s');
  for (const m of MOB_TYPES) {
    add(`mobs/${m}/ambient`, `a ${m} calls now and then (every 8–25 s)`, '0.5–1.5 s');
    add(`mobs/${m}/hurt`, `a ${m} is hit`, '0.3–0.6 s');
    add(`mobs/${m}/death`, `a ${m} dies`, '0.8–2 s');
  }
  add('liquids/lava_pop', 'reserved for lava bubbles (not played yet)', '0.3–0.6 s');
  add('liquids/lava_sizzle', 'lava meets water (cobblestone forms), an item burns', '0.5–1 s');
  add('ambient/wind', 'the wind bed, always on, louder high up and quieter indoors or under water', '20–30 s', true);
  add('ambient/water', 'the bubbling bed near water, fades in and out', '8–15 s', true);
  add('ambient/cave', 'a deep cave tone, rarely, when enclosed below y 50', '2–4 s');
  add('ambient/drip', 'a water drip with reverb, rarely, when enclosed below y 50', '1–3 s');
  add('ui/click', 'any menu or inventory button, hotbar swaps', '0.05–0.1 s');
  add('ui/hover', 'the mouse enters a menu button', '0.02–0.05 s');
  add('ui/inventory_open', 'the inventory, crafting table or furnace screen opens', '0.1–0.2 s');
  add('ui/inventory_close', 'that screen closes', '0.1–0.2 s');
  add('ui/craft', 'an item is crafted', '0.2–0.3 s');
  add('ui/smelt', 'an item is smelted in the furnace', '0.4–0.6 s');
  return Object.freeze(list);
})();
