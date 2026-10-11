const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

function createHelpModule({ getCommands, voteStarterIds = new Set() }) {
  function buildCommands() {
    return [new SlashCommandBuilder().setName('help').setDescription('List sliceBoi commands and what they do (vote starters only).')];
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'help') return false;

    if (!voteStarterIds.has(interaction.user?.id)) {
      await interaction.reply({
        content: 'You are not allowed to use /help.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const commands = getCommands().map((command) => command.toJSON());
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('sliceBoi Command Help')
      .addFields(commands.map((command) => ({
        name: `/${command.name}`,
        value: command.description,
      })))
      .setFooter({ text: 'Only you can see this message. Use Dismiss message to close it.' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }

  return { buildCommands, handleInteraction };
}

module.exports = { createHelpModule };
