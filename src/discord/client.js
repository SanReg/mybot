const { Client, GatewayIntentBits } = require('discord.js');

function createDiscordClient() {
  // Slash commands and buttons supply their own input and member data.
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}

module.exports = { createDiscordClient };
