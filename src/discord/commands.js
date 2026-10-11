async function registerCommands(client, modules, testGuildIds) {
  const commands = modules.flatMap((module) => module.buildCommands()).map((command) => command.toJSON());
  // Bulk replacement also removes the retired quiz commands.
  await client.application.commands.set(commands);
  console.log('Registered global slash commands (can take time to appear).');
  for (const guildId of testGuildIds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`Registered slash commands for test guild ${guildId}`);
    } catch (error) {
      if (error?.code === 10004) {
        console.warn(`Skipping unknown test guild ${guildId}. Remove it from GUILD_IDS if it is no longer valid.`);
      } else {
        console.error(`Failed to register commands for test guild ${guildId}:`, error);
      }
    }
  }
}

module.exports = { registerCommands };
