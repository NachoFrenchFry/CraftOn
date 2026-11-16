// WorldSettings.js — the per-world settings (Nov 10 2026): the rows of the one Create World form (Play and Multiplayer →
// Host share it), their defaults, and the helpers every reader uses so an old world without a key behaves exactly as the
// table says. Everything but the name, seed and the player's own game mode is stored in `worlds.data` (CloudSaveManager),
// lives on `game.worldMeta` while a world is open, and the in-game World / Server Settings screen changes it live; the
// host's WELCOME and WORLD messages carry the guest-visible ones (worldSettingsMessage / applyWorldSettingsMessage).

import { WORLD_TYPE_LABELS, CLASSIC_FLAT_LAYERS, worldTypeOf, normalizeFlatLayers } from '../generation/Superflat.js';

/** The defaults of every world setting (a missing key in an old world means this). */
export const WORLD_DEFAULTS = Object.freeze({
  gameMode: 'survival',
  modeLocked: false,
  worldType: 'default',
  flatLayers: CLASSIC_FLAT_LAYERS,
  defaultGameMode: 'survival',
  fallDamage: true,
  naturalMobs: true,
  hostileMobs: true,
  keepInventory: false,
  pvp: true,
  explosives: true,
  explosionsBreakBlocks: true,
  lanOpen: true, // on by default since Nov 12 2026: a world without the key counts as on; a world saved as off stays off
  structuresAvoidRavines: false, // a world WITHOUT the key keeps its old structure placement; CloudSaveManager.createWorld writes true for every new world (Nov 15 2026). Not shown on any screen.
});

/** The keys kept in `worlds.data` (the name, seed and game mode are row columns). */
export const WORLD_DATA_KEYS = Object.freeze(['worldType', 'flatLayers', 'structuresAvoidRavines', 'defaultGameMode', 'fallDamage', 'naturalMobs', 'hostileMobs', 'keepInventory', 'pvp', 'explosives', 'explosionsBreakBlocks', 'lanOpen']);

/** The booleans the guests follow live (WELCOME and Msg.WORLD). */
export const WORLD_MESSAGE_KEYS = Object.freeze(['keepInventory', 'pvp', 'hostileMobs', 'explosives', 'explosionsBreakBlocks', 'fallDamage', 'naturalMobs']);

export const LAN_HINT = 'Players on your Wi-Fi can join while you play. To play with people on other networks, host this world from Multiplayer → Host New Server.';
export const LOCK_HINT = 'Everyone in this world always plays in this game mode. This can never be turned off.';

// ---- the Pure Survival badge and the game mode lock (part 3 of 4, Nov 11 2026) ----
/** The sentence every confirmation shows before the badge is lost. */
export const BADGE_SENTENCE = "This permanently removes this world's Pure Survival badge.";
/** A cheat command's first reply while the badge is at stake (the same command typed again within CHEAT_CONFIRM_WINDOW_MS runs). */
export const BADGE_CONFIRM_COMMAND = BADGE_SENTENCE + ' Type the command again to confirm.';
export const CHEAT_CONFIRM_WINDOW_MS = 15000;
/** The badge could not be written off (offline): the action is refused. */
export const OFFLINE_TEXT = "Couldn't reach the server. Try again.";
/** A guest without the host's permission. */
export const NO_CHEATS_TEXT = "You don't have permission to use cheats.";
export const MODE_NAMES = Object.freeze({ survival: 'Survival', creative: 'Creative', spectator: 'Spectator' });
export function modeName(mode) { return MODE_NAMES[mode] || String(mode || ''); }
/** "This world is locked to Survival" — the one sentence for every refused mode change in a locked world. */
export function lockedText(mode) { return `This world is locked to ${modeName(mode)}`; }

const MODE_OPTIONS = [['survival', 'Survival'], ['creative', 'Creative']];
const GUEST_MODE_OPTIONS = [['survival', 'Survival'], ['creative', 'Creative'], ['spectator', 'Spectator']];

/**
 * The rows of the Create World form, in order (SettingRow schemas: key, label, hint, type 'text' | 'select' | 'toggle',
 * options). `flatLayers` is the layer editor (CreateWorldForm builds it), shown only while the world type is Superflat.
 */
export const CREATE_WORLD_ROWS = Object.freeze([
  { key: 'name', label: 'World name', type: 'text', maxLength: 32, hint: 'Shown in your world list and to the players who join' },
  { key: 'seed', label: 'Seed', type: 'text', maxLength: 32, placeholder: 'any text or number', hint: 'Blank = random. The same seed always makes the same terrain' },
  { key: 'gameMode', label: 'Your game mode', type: 'select', options: MODE_OPTIONS, hint: 'Survival: health, hunger-free mining and crafting. Creative: fly and build with every block' },
  { key: 'modeLocked', label: 'Lock game mode', type: 'toggle', hint: LOCK_HINT },
  { key: 'worldType', label: 'World type', type: 'select', options: [['default', WORLD_TYPE_LABELS.default], ['superflat', WORLD_TYPE_LABELS.superflat]], hint: 'Default: hills, caves, oceans and structures. Superflat: only the layers below, plains everywhere. Cannot change later' },
  { key: 'flatLayers', label: 'Superflat layers', type: 'layers', hint: 'Top layer first, the way the world looks from the side' },
  { key: 'defaultGameMode', label: 'Game mode for other players', type: 'select', options: GUEST_MODE_OPTIONS, hint: 'What a player who joins starts in. You can change it per player in Server Settings' },
  { key: 'fallDamage', label: 'Fall damage', type: 'toggle', hint: 'Landing hurts players and mobs. Glider crashes and the void always hurt' },
  { key: 'naturalMobs', label: 'Natural mob spawning', type: 'toggle', hint: 'Animals appear in new chunks and zombies in the dark. Spawn eggs always work' },
  { key: 'hostileMobs', label: 'Hostile mobs', type: 'toggle', hint: 'Zombies spawn in darkness (needs natural spawning)' },
  { key: 'keepInventory', label: 'Keep inventory on death', type: 'toggle', hint: 'Nothing drops when you die' },
  { key: 'pvp', label: 'PvP', type: 'toggle', hint: 'Players can hurt each other' },
  { key: 'explosives', label: 'Explosives', type: 'toggle', hint: 'Explosives can be placed and primed' },
  { key: 'explosionsBreakBlocks', label: 'Explosions break blocks', type: 'toggle', hint: 'Off: explosions only hurt' },
  { key: 'lanOpen', label: 'Same Wi-Fi multiplayer', type: 'toggle', hint: LAN_HINT },
]);

/** A world setting with the table's default for a missing key (old worlds). */
export function worldSetting(meta, key) {
  const v = meta ? meta[key] : undefined;
  return v === undefined || v === null ? WORLD_DEFAULTS[key] : v;
}

/** Fill a loaded world record with the defaults of every missing key and normalise the world type and layers (in place). */
export function normalizeWorldMeta(meta) {
  if (!meta) return meta;
  for (const key of WORLD_DATA_KEYS) if (key !== 'flatLayers' && (meta[key] === undefined || meta[key] === null)) meta[key] = WORLD_DEFAULTS[key];
  meta.survivalOnly = meta.survivalOnly === true; // row columns (CloudSaveManager._record): the badge and the lock
  meta.modeLocked = meta.modeLocked === true;
  meta.worldType = worldTypeOf(meta.worldType);
  if (meta.worldType === 'superflat') meta.flatLayers = normalizeFlatLayers(meta.flatLayers).layers;
  else delete meta.flatLayers;
  return meta;
}

/** The guest-visible settings of a world as the WELCOME / WORLD message carries them. */
export function worldSettingsMessage(meta) {
  const out = {};
  for (const key of WORLD_MESSAGE_KEYS) out[key] = worldSetting(meta, key) !== false;
  out.worldType = worldTypeOf(meta && meta.worldType);
  if (out.worldType === 'superflat') out.flatLayers = normalizeFlatLayers(meta && meta.flatLayers).layers;
  out.structuresAvoidRavines = !!(meta && meta.structuresAvoidRavines === true); // guests must place the structures where the host does
  // The Pure Survival badge (live: it can only go away) and the lock — the mode everyone in the world plays in, or null.
  out.survivalOnly = !!(meta && meta.survivalOnly === true);
  out.lockedMode = lockedModeOf(meta);
  return out;
}

/** The mode a locked world holds everyone to (the mode it was created in), or null when it is not locked. */
export function lockedModeOf(meta) {
  if (!meta || meta.modeLocked !== true) return null;
  const mode = meta.lockedMode || meta.gameMode;
  return MODE_NAMES[mode] ? mode : 'survival';
}

/** A guest applies a WORLD message (or the WELCOME) to its copy of the world settings: every boolean, a missing one meaning its default. */
export function applyWorldSettingsMessage(meta, msg) {
  if (!meta || !msg) return;
  for (const key of WORLD_MESSAGE_KEYS) meta[key] = msg[key] === undefined ? WORLD_DEFAULTS[key] : msg[key] !== false;
  if ('structuresAvoidRavines' in msg) meta.structuresAvoidRavines = msg.structuresAvoidRavines === true;
  if ('survivalOnly' in msg) meta.survivalOnly = msg.survivalOnly === true;
  if ('lockedMode' in msg) { meta.modeLocked = !!msg.lockedMode; meta.lockedMode = msg.lockedMode || null; }
}

export { WORLD_TYPE_LABELS };
