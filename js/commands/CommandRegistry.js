// CommandRegistry.js — chat commands: a chat line starting with "/" is a command. One file per command in this folder
// registers itself here. Every command declares its syntax — one or more forms, each a list of argument specs:
//   { kind: 'literal', value: 'gamemode' }                                  a fixed subcommand word
//   { kind: 'enum', name: 'mode', values: [...] | (game) => [...], label?: (v) => string, optional?: true }
//   { kind: 'int', name: 'rate', min: 1, max: 100, optional?: true, examples?: ['10', '20'] }
//   { kind: 'coords', name: 'pos' }                                         three numbers x y z ("~" = here)
// The registry uses the syntax for parsing and validation (run), the usage text (help), the suggestion popup
// (suggest: rows, a usage hint with the current argument, red hints for invalid input, greyed rows the player may not
// use) and Tab completion (complete). Feedback goes only to the player who typed the command through `reply`.

/**
 * A command: { name, description, syntax: ArgSpec[][], run(game, argv, reply, match), permitted?(game) → true | reason }.
 * `reply(text | parts[], kind)` prints to this player's chat (`kind` 'info' | 'error'); `parts` are chat segments
 * ({ text, bold?, copy? } — a `copy` segment is clickable and copies that text).
 */
export class CommandRegistry {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** name → command */
    this.commands = new Map();
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

  /** The options of an enum (static list or a function of the game). */
  enumValues(a) { const v = typeof a.values === 'function' ? a.values(this.game) : a.values; return Array.isArray(v) ? v : []; }

  /** Does the typed word satisfy the argument? Returns { ok, value, error }. */
  _checkArg(a, word) {
    const w = String(word);
    if (a.kind === 'literal') return w.toLowerCase() === a.value ? { ok: true, value: a.value } : { ok: false, error: null };
    if (a.kind === 'enum') { const hit = this.enumValues(a).find((v) => v.toLowerCase() === w.toLowerCase()); return hit !== undefined ? { ok: true, value: hit } : { ok: false, error: `Unknown ${a.name} '${w}'` }; }
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
    for (const form of cmd.syntax) {
      const values = [];
      let i = 0, error = null, depth = 0;
      for (const a of form) {
        const span = a.kind === 'coords' ? 3 : 1;
        if (i >= argv.length) { if (a.optional) break; error = `Usage: ${CommandRegistry.usage(cmd.name, form)}`; break; }
        if (a.kind === 'coords') {
          const parts = argv.slice(i, i + 3);
          if (parts.length < 3 || !parts.every((p) => this._checkArg(a, p).ok)) { error = `${a.name} needs three numbers (x y z)`; break; }
          values.push(parts); i += span; depth++; continue;
        }
        const r = this._checkArg(a, argv[i]);
        if (!r.ok) { error = r.error || `Usage: ${CommandRegistry.usage(cmd.name, form)}`; break; }
        values.push(r.value); i += span; depth++;
      }
      if (!error && i < argv.length) error = `Too many arguments. Usage: ${CommandRegistry.usage(cmd.name, form)}`;
      if (!error) return { form, values, error: null };
      if (!closest || depth > closest.depth) closest = { form, error, depth };
    }
    return closest ? { form: closest.form, values: null, error: closest.error } : { form: null, values: null, error: `Usage: ${this.usages(cmd).join(' | ')}` };
  }

  /** Why the player may not use a command right now (a string), or null. */
  denied(cmd) { if (!cmd.permitted) return null; const r = cmd.permitted(this.game); return r === true || r === undefined || r === null ? null : String(r); }

  /** Run a "/command args" line; `reply(text, kind)` receives the feedback. Returns false for an unknown command. */
  run(line, reply) {
    const { name, argv } = CommandRegistry.parse(line);
    const cmd = this.commands.get(name);
    if (!cmd) { reply('Unknown command. Type /help', 'error'); return false; }
    const denied = this.denied(cmd);
    if (denied) { reply(denied, 'error'); return true; }
    const m = this.match(cmd, argv);
    if (m.error) { reply(m.error, 'error'); return true; }
    try { cmd.run(this.game, argv, reply, m); }
    catch (e) { console.warn(`CraftOn command /${name} failed`, e); reply(`/${name} failed: ${e.message || e}`, 'error'); }
    return true;
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
      if (pos > hintDepth) { hintDepth = pos; hintSpec = a; hint = { before: ['/' + cmd.name, ...form.slice(0, pos).map((x) => CommandRegistry.argText(x))].join(' ') + ' ', current: CommandRegistry.argText(a), after: form.slice(pos + 1).map((x) => ' ' + CommandRegistry.argText(x)).join('') }; }
      const more = form.length > pos + 1;
      const add = (text, detail) => { if (!options.has(text)) options.set(text, { text, label: text, detail: detail || '', prefix: true, disabled, needsSpace: more }); else if (more) options.get(text).needsSpace = true; };
      if (a.kind === 'literal') add(a.value, '');
      else if (a.kind === 'enum') for (const v of this.enumValues(a)) add(v, a.label ? a.label(v) : '');
      else if (a.kind === 'int') for (const v of a.examples || []) add(String(v), '');
    }
    out.items = sortRows([...options.values()], word);
    out.hint = hint;
    if (!anyForm && tooMany && !firstError) { out.error = 'Too many arguments'; return out; }
    if (firstError && !anyForm) { out.error = firstError; return out; }
    if (word && !out.items.length) {
      const spec = hintSpec;
      if (spec && (spec.kind === 'enum' || spec.kind === 'literal')) out.error = `Unknown ${spec.kind === 'enum' ? spec.name : 'option'} '${word}'`;
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
