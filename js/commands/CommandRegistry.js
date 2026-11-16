// CommandRegistry.js — chat commands: a chat line starting with "/" is a command. One file per command in this folder
// registers itself here. Every command declares its syntax — one or more forms, each a list of argument specs:
//   { kind: 'literal', value: 'gamemode' }                                  a fixed subcommand word
//   { kind: 'enum', name: 'mode', values: [...] | (game) => [...], label?: (v) => string, optional?: true }
//   { kind: 'int', name: 'rate', min: 1, max: 100, optional?: true, examples?: ['10', '20'] }
//   { kind: 'coords', name: 'pos' }                                         three numbers x y z ("~" = here)
//   { kind: 'player' | 'item' | 'mob', name }                                a player / item / mob name (part 3, Nov 11 2026):
//                                                                            the game lists them (playerNames / itemNames / mobNames)
// The registry uses the syntax for parsing and validation (run), the usage text (help), the suggestion popup
// (suggest: rows, a usage hint with the current argument, red hints for invalid input, greyed rows the player may not
// use) and Tab completion (complete). Feedback goes only to the player who typed the command through `reply`.
// Cheats (`cheat: true`, or a function of the match for /set gamemode): refused by game.cheatDenied() — a world locked to
// Survival, a guest without the host's permission — and, while the world still has its Pure Survival badge, run only when
// the same command is typed again within 15 s (the first try answers BADGE_CONFIRM_COMMAND); the badge is written off
// (game.loseBadge) before the command runs, and a failed write refuses it with OFFLINE_TEXT.
import { BADGE_CONFIRM_COMMAND, CHEAT_CONFIRM_WINDOW_MS, OFFLINE_TEXT } from '../core/WorldSettings.js';

const NAMED_KINDS = new Set(['enum', 'player', 'item', 'mob']);

/** "~", "~5", "-3" per axis against a position: the absolute coordinates of a `coords` argument. */
export function resolveCoords(parts, at) {
  const axes = ['x', 'y', 'z'];
  const out = {};
  parts.forEach((w, i) => {
    const base = at ? Number(at[axes[i]]) || 0 : 0;
    out[axes[i]] = w.startsWith('~') ? base + (w.length > 1 ? Number(w.slice(1)) : 0) : Number(w);
  });
  return out;
}

/**
 * A command: { name, description, syntax: ArgSpec[][], run(game, argv, reply, match, actor?), permitted?(game) → true | reason,
 * cheat?: boolean | (game, match) => boolean, remote?: true }. `reply(text | parts[], kind)` prints to this player's chat
 * (`kind` 'info' | 'error'); `parts` are chat segments ({ text, bold?, copy? } — a `copy` segment is clickable and copies
 * that text). `remote` commands are run by the host for a guest (HostServer._command passes the guest as `actor`).
 */
export class CommandRegistry {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** name → command */
    this.commands = new Map();
    /** The cheat waiting for its confirmation: { key, at } (the normalised line and when it was first typed). */
    this.pendingCheat = null;
  }

  register(command) {
    if (!Array.isArray(command.syntax) || !command.syntax.length) command.syntax = [[]];
    this.commands.set(command.name, command);
    return this;
  }

  get(name) { return this.commands.get(name) || null; }

  /** Every command, sorted by name (for /help and completion). */
  list() { return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name)); }

  /** Split a line into words (the leading "/" removed). */
  static parse(line) {
    const words = String(line).trim().replace(/^\//, '').split(/\s+/).filter((w) => w.length > 0);
    return { name: (words[0] || '').toLowerCase(), argv: words.slice(1) };
  }

  // ---- syntax helpers ----

  /** The placeholder of one argument spec: gamemode, <mode>, <1-100>, [n], <x> <y> <z>. */
  static argText(a) {
    let t;
    if (a.kind === 'literal') return a.value;
    if (a.kind === 'int') t = a.min !== undefined && a.max !== undefined ? `${a.min}-${a.max}` : a.name;
    else if (a.kind === 'coords') return a.optional ? '[x] [y] [z]' : '<x> <y> <z>';
    else t = a.name;
    return a.optional ? `[${t}]` : `<${t}>`;
  }

  /** "/tick rate <1-100>" for one form of a command. */
  static usage(name, form) { return ['/' + name, ...form.map((a) => CommandRegistry.argText(a))].join(' '); }

  /** Every usage line of a command. */
  usages(cmd) { return cmd.syntax.map((form) => CommandRegistry.usage(cmd.name, form)); }

  /** The options of an enum (static list or a function of the game) or of a player / item / mob argument (the game lists them). */
  enumValues(a) {
    if (a.kind === 'player' || a.kind === 'item' || a.kind === 'mob') { const fn = this.game[a.kind + 'Names']; const v = typeof fn === 'function' ? fn.call(this.game) : []; return Array.isArray(v) ? v : []; }
    const v = typeof a.values === 'function' ? a.values(this.game) : a.values; return Array.isArray(v) ? v : [];
  }

  /** The readable label of one option (the spec's `label`, else the game's itemLabel / mobLabel / playerLabel). */
  labelOf(a, v) {
    if (a.label) return a.label(v);
    const fn = this.game[a.kind + 'Label'];
    return typeof fn === 'function' ? fn.call(this.game, v) || '' : '';
  }

  /** Does the typed word satisfy the argument? Returns { ok, value, error }. */
  _checkArg(a, word) {
    const w = String(word);
    if (a.kind === 'literal') return w.toLowerCase() === a.value ? { ok: true, value: a.value } : { ok: false, error: null };
    if (NAMED_KINDS.has(a.kind)) { const hit = this.enumValues(a).find((v) => v.toLowerCase() === w.toLowerCase()); return hit !== undefined ? { ok: true, value: hit } : { ok: false, error: `Unknown ${a.name} '${w}'` }; }
    if (a.kind === 'int') {
      const n = /^-?\d+$/.test(w) ? Number(w) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: `${a.name} must be a whole number` };
      if ((a.min !== undefined && n < a.min) || (a.max !== undefined && n > a.max)) return { ok: false, error: `${a.name} must be ${a.min}-${a.max}` };
      return { ok: true, value: n };
    }
    if (a.kind === 'coords') return { ok: /^(~-?\d*|-?\d+)$/.test(w), value: w, error: `${a.name} needs three numbers (x y z)` };
    return { ok: false, error: 'bad argument' };
  }

  /**
   * Match argv against a command's forms. Returns { form, values } for a full match, else
   * { form: the closest form, error } with a message for the first wrong / missing argument.
   */
  match(cmd, argv) {
    let closest = null;
    const numeric = (w) => /^(~|-?\d)/.test(String(w || ''));
    for (const form of cmd.syntax) {
      const values = [];
      let i = 0, error = null, depth = 0, failed = null, at = 0;
      for (const a of form) {
        const span = a.kind === 'coords' ? 3 : 1;
        if (i >= argv.length) { if (a.optional) break; error = `Usage: ${CommandRegistry.usage(cmd.name, form)}`; break; }
        if (a.kind === 'coords') {
          const parts = argv.slice(i, i + 3);
          if (parts.length < 3 || !parts.every((p) => this._checkArg(a, p).ok)) { error = `${a.name} needs three numbers (x y z)`; failed = a; at = i; break; }
          values.push(parts); i += span; depth++; continue;
        }
        const r = this._checkArg(a, argv[i]);
        if (!r.ok) { error = r.error || `Usage: ${CommandRegistry.usage(cmd.name, form)}`; failed = a; at = i; break; }
        values.push(r.value); i += span; depth++;
      }
      if (!error && i < argv.length) error = `Too many arguments. Usage: ${CommandRegistry.usage(cmd.name, form)}`;
      if (!error) return { form, values, error: null };
      // The message of the form that got furthest; at a tie the one whose failing argument fits what was typed (numbers for
      // coordinates, a word for a name), so "/tp nobody" says Unknown player and "/tp 1 2" asks for three numbers.
      const rank = depth * 10 + (failed && (failed.kind === 'coords') === numeric(argv[at]) ? 1 : 0);
      if (!closest || rank > closest.rank) closest = { form, error, rank };
    }
    return closest ? { form: closest.form, values: null, error: closest.error } : { form: null, values: null, error: `Usage: ${this.usages(cmd).join(' | ')}` };
  }

  /** Why the player may not use a command right now (a string), or null: its own `permitted`, then — for a cheat — the lock / permission rule. */
  denied(cmd) {
    if (cmd.permitted) { const r = cmd.permitted(this.game); if (!(r === true || r === undefined || r === null)) return String(r); }
    if (cmd.cheat === true) { const why = this.cheatDenied(); if (why) return why; }
    return null;
  }

  /** Is this matched command a cheat (teleports, /give, /summon, /setspawn, /tick, /locate, leaving Survival)? */
  isCheat(cmd, m) { return typeof cmd.cheat === 'function' ? !!cmd.cheat(this.game, m) : !!cmd.cheat; }

  /** The game's reason no cheat may run now (a Survival lock, a guest without permission), or null. */
  cheatDenied() { return typeof this.game.cheatDenied === 'function' ? this.game.cheatDenied() : null; }

  /** Would a cheat take the world's Pure Survival badge (the host / single player only: guests never own the badge)? */
  badgeAtStake() { return !!this.game.survivalOnly && !this.game.isGuest; }

  /**
   * Run a "/command args" line; `reply(text, kind)` receives the feedback. Returns false for an unknown command, true
   * otherwise — or a promise of true when the world's badge had to be written off first.
   */
  run(line, reply) {
    const { name, argv } = CommandRegistry.parse(line);
    const cmd = this.commands.get(name);
    if (!cmd) { reply('Unknown command. Type /help', 'error'); return false; }
    const denied = this.denied(cmd);
    if (denied) { reply(denied, 'error'); return true; }
    const m = this.match(cmd, argv);
    if (m.error) { reply(m.error, 'error'); return true; }
    if (this.isCheat(cmd, m)) {
      const why = this.cheatDenied();
      if (why) { reply(why, 'error'); return true; }
      if (this.badgeAtStake()) {
        // The first try only warns; the same command again within the window removes the badge (written first) and runs.
        const key = [name, ...argv.map((a) => a.toLowerCase())].join(' '), now = Date.now();
        const pending = this.pendingCheat;
        if (!pending || pending.key !== key || now - pending.at > CHEAT_CONFIRM_WINDOW_MS) { this.pendingCheat = { key, at: now }; reply(BADGE_CONFIRM_COMMAND, 'info'); return true; }
        this.pendingCheat = null;
        return Promise.resolve(this.game.loseBadge({ confirm: false, silent: true })).then((ok) => { if (!ok) { reply(OFFLINE_TEXT, 'error'); return true; } this._exec(cmd, name, argv, reply, m); return true; });
      }
    }
    this._exec(cmd, name, argv, reply, m);
    return true;
  }

  _exec(cmd, name, argv, reply, m) {
    try { cmd.run(this.game, argv, reply, m); }
    catch (e) { console.warn(`CraftOn command /${name} failed`, e); reply(`/${name} failed: ${e.message || e}`, 'error'); }
  }

  /**
   * Suggestions for the text in the chat box (the popup). Returns:
   * { line, replaceStart, items: [{ text, label, detail, prefix, disabled, needsSpace }], hint: { before, current, after } | null, error }
   * - the command word: one row per form of every command whose name starts with (then contains) the typed text;
   * - an argument: the options of that argument in every form whose earlier words match, prefix matches first then
   *   containing ones, alphabetical within each group; `hint` is the usage with the current argument marked;
   * - `error` names an invalid word ("Unknown biome 'desrt'", "rate must be 1-100", "Too many arguments").
   * Rows of commands the player may not use are `disabled` with the reason.
   */
  suggest(line) {
    const out = { line, replaceStart: line.length, items: [], hint: null, error: null };
    if (!line.startsWith('/')) return out;
    const endsWithSpace = /\s$/.test(line);
    const { name, argv } = CommandRegistry.parse(line);
    const firstWord = !endsWithSpace && argv.length === 0;
    const sortRows = (rows, word) => {
      const w = word.toLowerCase();
      const pre = rows.filter((r) => r.text.toLowerCase().startsWith(w)).sort((a, b) => a.text.localeCompare(b.text));
      const inc = w ? rows.filter((r) => !r.text.toLowerCase().startsWith(w) && r.text.toLowerCase().includes(w)).sort((a, b) => a.text.localeCompare(b.text)) : [];
      pre.forEach((r) => { r.prefix = true; }); inc.forEach((r) => { r.prefix = false; });
      return pre.concat(inc);
    };
    if (firstWord) {
      out.replaceStart = 1;
      const rows = [];
      for (const cmd of this.list()) {
        const disabled = this.denied(cmd);
        for (const form of cmd.syntax) rows.push({ text: cmd.name, label: CommandRegistry.usage(cmd.name, form), detail: cmd.description, prefix: true, disabled, needsSpace: form.length > 0 });
      }
      const sorted = sortRows(rows, name);
      // keep each command's forms together in the order they were declared
      out.items = sorted;
      if (name && !sorted.length) out.error = `Unknown command '/${name}'`;
      out.hint = null;
      return out;
    }
    const cmd = this.commands.get(name);
    if (!cmd) { out.error = `Unknown command '/${name}'`; return out; }
    const disabled = this.denied(cmd);
    const typed = endsWithSpace ? [...argv, ''] : argv;
    const index = typed.length - 1;           // the argument being typed
    const word = typed[index];
    out.replaceStart = endsWithSpace ? line.length : line.length - word.length;
    const options = new Map();                // text → row
    let hint = null, hintSpec = null, hintDepth = -1, anyForm = false, firstError = null, tooMany = true;
    const specsAtDepth = []; // every form's argument at the deepest position reached (for the red hint of an unknown word)
    for (const form of cmd.syntax) {
      // the earlier words must fit this form
      let ok = true, i = 0, pos = 0;
      for (; pos < form.length && i < index; pos++) {
        const a = form[pos];
        if (a.kind === 'coords') { i += 3; continue; }
        const r = this._checkArg(a, typed[i]);
        if (!r.ok) { if (!firstError && a.kind !== 'literal') firstError = r.error; ok = false; break; }
        i++;
      }
      if (!ok) continue;
      if (pos >= form.length) { continue; }    // this form is complete: nothing more to type
      tooMany = false;
      const a = form[pos];
      anyForm = true;
      if (pos > hintDepth) { hintDepth = pos; hintSpec = a; specsAtDepth.length = 0; hint = { before: ['/' + cmd.name, ...form.slice(0, pos).map((x) => CommandRegistry.argText(x))].join(' ') + ' ', current: CommandRegistry.argText(a), after: form.slice(pos + 1).map((x) => ' ' + CommandRegistry.argText(x)).join('') }; }
      if (pos === hintDepth) specsAtDepth.push(a);
      const more = form.length > pos + 1;
      const add = (text, detail) => { if (!options.has(text)) options.set(text, { text, label: text, detail: detail || '', prefix: true, disabled, needsSpace: more }); else if (more) options.get(text).needsSpace = true; };
      if (a.kind === 'literal') add(a.value, '');
      else if (NAMED_KINDS.has(a.kind)) for (const v of this.enumValues(a)) add(v, this.labelOf(a, v));
      else if (a.kind === 'int') for (const v of a.examples || []) add(String(v), '');
    }
    out.items = sortRows([...options.values()], word);
    out.hint = hint;
    if (!anyForm && tooMany && !firstError) { out.error = 'Too many arguments'; return out; }
    if (firstError && !anyForm) { out.error = firstError; return out; }
    if (word && !out.items.length) {
      // Several forms may expect different things here (/tp: coordinates or a player): a word that is not a number is judged as the name.
      const numeric = /^(~|-?\d)/.test(word);
      const spec = (!numeric && specsAtDepth.find((x) => NAMED_KINDS.has(x.kind) || x.kind === 'literal')) || hintSpec;
      if (spec && (NAMED_KINDS.has(spec.kind) || spec.kind === 'literal')) out.error = `Unknown ${spec.kind === 'literal' ? 'option' : spec.name} '${word}'`;
      else if (spec && spec.kind === 'int') { const r = this._checkArg(spec, word); if (!r.ok) out.error = r.error; }
    }
    return out;
  }

  /**
   * Tab completion (the older API, still used by tests): { text, candidates }. `text` is the line to put in the box
   * (completed to the common prefix of the prefix-matching options, plus a space when unique); `candidates` the options.
   */
  complete(line) {
    const s = this.suggest(line);
    const candidates = [...new Set(s.items.filter((r) => r.prefix).map((r) => r.text))]; // one entry per word (a command's forms share the name)
    if (!line.startsWith('/') || !candidates.length) return { text: line, candidates: [] };
    const head = line.slice(0, s.replaceStart);
    const prefix = line.slice(s.replaceStart);
    if (candidates.length === 1) return { text: head + candidates[0] + ' ', candidates };
    let common = candidates[0];
    for (const c of candidates) { let i = 0; while (i < common.length && i < c.length && common[i].toLowerCase() === c[i].toLowerCase()) i++; common = common.slice(0, i); }
    return { text: common.length > prefix.length ? head + common : line, candidates };
  }
}
