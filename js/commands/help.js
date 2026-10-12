// help.js — /help: every command with its usage and a short note.
export const help = {
  name: 'help',
  usage: '/help',
  description: 'lists the commands',
  run(game, argv, reply) {
    reply('Commands:', 'info');
    for (const c of game.commands.list()) reply(`${c.usage} — ${c.description}`, 'info');
  },
};
