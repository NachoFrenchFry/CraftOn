// locate.js — /locate structure <structure> and /locate biome <biome>: the nearest one from the player, found from the
// pure terrain functions without generating chunks (structures: the Part 1 region-grid starts; biomes: a spiral over the
// biome function), in a chunk worker so the game never freezes; "Searching…" after 200 ms. The reply's coordinates are
// clickable: a click copies "X Y Z" to the clipboard. Anyone in single player; in multiplayer the host always, a guest
// only when the host allows it to change its own game mode (the same permission as /set gamemode); guests search
// locally (terrain is deterministic).
import { BIOME_NAMES, biomeLabel, LOCATE_MAX_DISTANCE } from '../generation/Locate.js';

/** "plains_house_small" → "Plains House Small". */
export function structureLabel(name) { return String(name).split('_').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' '); }

export const locate = {
  name: 'locate',
  description: 'finds the nearest structure or biome',
  syntax: [
    [{ kind: 'literal', value: 'structure' }, { kind: 'enum', name: 'structure', values: (game) => game.structureNames || [], label: structureLabel }],
    [{ kind: 'literal', value: 'biome' }, { kind: 'enum', name: 'biome', values: BIOME_NAMES, label: biomeLabel }],
  ],
  permitted(game) { return game.isGuest && !game.net.canChangeMode ? "You don't have permission to use /locate." : true; },
  run(game, argv, reply, m) {
    const kind = m.values[0], target = m.values[1];
    const label = kind === 'biome' ? biomeLabel(target) : structureLabel(target);
    let announced = false;
    const timer = setTimeout(() => { announced = true; reply('Searching…', 'info'); }, 200);
    game.locate(kind, target).then((r) => {
      clearTimeout(timer);
      if (!r) { reply([{ text: 'No ' }, { text: label, bold: true }, { text: ` found within ${LOCATE_MAX_DISTANCE.toLocaleString('en-US')} blocks` }], 'info'); return; }
      const coords = `${r.x} ${r.y} ${r.z}`;
      if (kind === 'biome' && r.distance < 8) { reply([{ text: 'You are in a ' }, { text: label, bold: true }, { text: ' biome (' }, { text: `X ${r.x}, Z ${r.z}`, bold: true, copy: coords }, { text: ')' }], 'info'); return; }
      reply([{ text: 'The nearest ' }, { text: label, bold: true }, { text: ' is at ' }, { text: `X ${r.x}, Z ${r.z}`, bold: true, copy: coords }, { text: ` (${r.distance.toLocaleString('en-US')} blocks away)` }], 'info');
      void announced;
    }).catch((e) => { clearTimeout(timer); reply('/locate failed: ' + (e && e.message || e), 'error'); });
  },
};
