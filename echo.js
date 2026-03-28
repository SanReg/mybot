const { SlashCommandBuilder } = require('discord.js');

function createEchoModule({ echoMasterIds }) {
  const allowedUserIds = echoMasterIds || new Set();

  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('echo')
        .setDescription('Repeat a message in this channel (private response).')
        .addStringOption((option) =>
          option
            .setName('message')
            .setDescription('Message to repeat in this channel')
            .setRequired(true)
            .setMaxLength(2000)
        ),
    ];
  }

  async function handleInteraction(interaction) {
    if (interaction.commandName !== 'echo') {
      return false;
    }

    await handleEchoCommand(interaction);
    return true;
  }

  async function handleEchoCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    if (!interaction.channel || !interaction.channel.isTextBased()) {
      await interaction.reply({
        content: 'This command can only be used in a text channel.',
        flags: 64,
      });
      return;
    }

    if (!allowedUserIds.has(interaction.user.id)) {
      await interaction.reply({
        content: 'You are not allowed to use /echo.',
        flags: 64,
      });
      return;
    }

    const message = interaction.options.getString('message', true);

    await interaction.channel.send(message);
    await interaction.reply({
      content: 'Echo posted.',
      flags: 64,
    });
  }

  return {
    buildCommands,
    handleInteraction,
  };
}

module.exports = { createEchoModule };