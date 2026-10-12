// CommandRegistry.js — chat commands (Update #12): a chat line starting with "/" is a command. One file per
// command in this folder registers itself here; the registry parses the line, runs the command and offers
// Tab completion for command names and arguments. Feedback goes only to the player who typed the command
// (gray, red for errors) through `reply`.

/**
 * A command: { name, usage, description, run(ctx, argv, reply), complete(ctx, argv) → string[] }.
 * `ctx` is the game; `argv` the arguments after the command name; `reply(text, kind)` prints to this player's chat
 * (`kind` 'info' | 'error'); `complete` returns the candidates for the argument being typed (argv[argv.length - 1],
 * possibly '').
 */
export class CommandRegistry {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** name → command */
    this.commands = new Map();
  }

  register(command) { this.commands.set(command.name, command); return this; }

  get(name) { return this.commands.get(name) || null; }

  /** Every command, sorted by name (for /help and completion). */
  list() { return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name)); }

  /** Split a line into words (the leading "/" removed). */
  static parse(line) {
    const words = String(line).trim().replace(/^\//, '').split(/\s+/).filter((w) => w.length > 0);
    return { name: (words[0] || '').toLowerCase(), argv: words.slice(1) };
  }

  /** Run a "/command args" line; `reply(text, kind)` receives the feedback. Returns false for an unknown command. */
  run(line, reply) {
    const { name, argv } = CommandRegistry.parse(line);
    const cmd = this.commands.get(name);
    if (!cmd) { reply('Unknown command. Type /help', 'error'); return false; }
    try { cmd.run(this.game, argv, reply); }
    catch (e) { console.warn(`CraftOn command /${name} failed`, e); reply(`/${name} failed: ${e.message || e}`, 'error'); }
    return true;
  }

  /**
   * Tab completion for the text in the chat box: the command name while the first word is being typed, else the
   * command's own candidates for the last argument. Returns { text, candidates }: `text` is the line to put in the
   * box (unchanged when nothing matches; completed to the common prefix, plus a space when unique) and `candidates`
   * the matching options (more than one = ambiguous).
   */
  complete(line) {
    if (!line.startsWith('/')) return { text: line, candidates: [] };
    const endsWithSpace = /\s$/.test(line);
    const { name, argv } = CommandRegistry.parse(line);
    const firstWord = !endsWithSpace && argv.length === 0;
    let candidates, prefix, head;
    if (firstWord) {
      prefix = name;
      candidates = this.list().map((c) => c.name).filter((n) => n.startsWith(prefix));
      head = '/';
    } else {
      const cmd = this.commands.get(name);
      if (!cmd || !cmd.complete) return { text: line, candidates: [] };
      const args = endsWithSpace ? [...argv, ''] : argv;
      prefix = (args[args.length - 1] || '').toLowerCase();
      candidates = (cmd.complete(this.game, args) || []).filter((c) => c.toLowerCase().startsWith(prefix));
      head = '/' + [name, ...args.slice(0, -1)].join(' ') + ' ';
    }
    if (candidates.length === 0) return { text: line, candidates };
    if (candidates.length === 1) return { text: head + candidates[0] + ' ', candidates };
    let common = candidates[0];
    for (const c of candidates) { let i = 0; while (i < common.length && i < c.length && common[i].toLowerCase() === c[i].toLowerCase()) i++; common = common.slice(0, i); }
    return { text: common.length > prefix.length ? head + common : line, candidates };
  }
}
