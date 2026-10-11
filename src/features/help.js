const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const ACCESS_NOTES = {
  'start-vote': 'Available to configured vote starters. Duration is 1–168 hours; supply 2–10 entry links.',
  'end-vote': 'Available to configured vote starters.',
  'vote-results': 'Available to configured vote starters. Results are private.',
  'vote-details': 'Available to configured vote starters. Details are private.',
  'remove-votes': 'Available to configured vote starters.',
  echo: 'Available to configured echo users. The supplied text is posted publicly.',
  lock: 'Available to configured lock manager roles.',
  unlock: 'Available to configured lock manager roles.',
  'meme-list': 'Available to configured vote starters. Days specifies how far back to look.',
  'art-list': 'Available to configured vote starters. Days specifies how far back to look.',
};

function formatOption(option) {
  const placeholders = { duration: 'hours', days: 'number', message: 'text', user: '@user' };
  const value = option.choices?.map((choice) => choice.value).join('|')
    || placeholders[option.name]
    || (option.name.startsWith('entry') ? 'url' : 'value');
  const usage = `${option.name}:<${value}>`;
  return option.required ? usage : `[${usage}]`;
}

function createHelpModule({ getCommands }) {
  function buildCommands() {
    return [new SlashCommandBuilder().setName('help').setDescription('List sliceBoi commands and how to use them.')];
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'help') return false;

    const commands = getCommands().map((command) => command.toJSON());
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('sliceBoi • Command Help')
      .setDescription('Choose a slash command from Discord’s command menu. Options in [brackets] are optional.\nFor voting, select Meme or Art, then use the entry buttons to vote. You get three votes for different entries.')
      .addFields(commands.map((command) => {
        const usage = [`/${command.name}`, ...(command.options || []).map(formatOption)].join(' ');
        const note = ACCESS_NOTES[command.name];
        return {
          name: `/${command.name}`,
          value: `${command.description}\n**Usage:** \`${usage}\`${note ? `\n${note}` : ''}`,
        };
      }))
      .setFooter({ text: 'Only you can see this message. Use Dismiss message to close it.' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }

  return { buildCommands, handleInteraction };
}

module.exports = { createHelpModule };
