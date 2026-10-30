// help.js — /help [command]: every command with its usage lines and a short note, or one command in detail.
export const help = {
  name: 'help',
  description: 'lists the commands',
  syntax: [[{ kind: 'enum', name: 'command', values: (game) => game.commands.list().map((c) => c.name), optional: true }]],
  run(game, argv, reply) {
    const reg = game.commands;
    if (argv[0]) {
      const c = reg.get(argv[0].toLowerCase());
      if (!c) { reply(`Unknown command '/${argv[0]}'. Type /help`, 'error'); return; }
      reply(`/${c.name} — ${c.description}`, 'info');
      for (const u of reg.usages(c)) reply(u, 'info');
      return;
    }
    reply('Commands (type / in the chat for suggestions):', 'info');
    for (const c of reg.list()) for (const u of reg.usages(c)) reply(`${u} — ${c.description}`, 'info');
  },
};
