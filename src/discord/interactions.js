function createInteractionHandler(modules) {
  return async (interaction) => {
    const isCommand = interaction.isChatInputCommand();
    if (!isCommand && !interaction.isButton()) return;
    try {
      // Voting is the only module that handles buttons.
      if (await modules[0].handleInteraction(interaction)) return;
      if (!isCommand) return;
      for (const module of modules.slice(1)) {
        if (await module.handleInteraction(interaction)) return;
      }
    } catch (error) {
      console.error('interactionCreate error:', error);
      if (error?.code === 10062 || error?.code === 40060) return;
      const response = { content: 'Something went wrong while processing this command.', flags: 64 };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(response).catch(() => null);
      } else {
        await interaction.reply(response).catch(() => null);
      }
    }
  };
}

module.exports = { createInteractionHandler };
