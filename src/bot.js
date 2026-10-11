const { createDiscordClient } = require('./discord/client');
const { registerCommands } = require('./discord/commands');
const { createInteractionHandler } = require('./discord/interactions');
const { createFeatures } = require('./features');
const { createHealthApp } = require('./http/health');
const { startActivityStatusLoop } = require('./services/status');
const { startRedditRelayLoop } = require('./features/reddit');
const { startRedditArtRelayLoop } = require('./features/reddit-art');

function startBot(config) {
  const client = createDiscordClient();
  const { modules, voting } = createFeatures(config);
  const state = { discordLoginStartedAt: null, lastDiscordLoginError: null };
  const app = createHealthApp({ client, voting, state });
  let healthServer;
  let healthTimer;
  function startHealthServer() {
    if (healthServer) return;
    clearTimeout(healthTimer);
    healthServer = app.listen(config.port, () => console.log(`Health server listening on port ${config.port}`));
  }
  client.once('clientReady', async () => {
    state.lastDiscordLoginError = null;
    console.log(`Discord bot logged in as ${client.user.tag}`);
    startActivityStatusLoop({ client });
    startRedditRelayLoop({ client, ...config.reddit });
    startRedditArtRelayLoop({ client, ...config.redditArt });
    try {
      await registerCommands(client, modules, config.testGuildIds);
    } catch (error) {
      console.error('Slash command registration failed:', error);
    } finally {
      startHealthServer();
    }
  });
  client.on('interactionCreate', createInteractionHandler(modules));
  client.on('error', (error) => {
    state.lastDiscordLoginError = `Client error: ${error.message}`;
    console.error('Discord client error:', error);
  });
  client.on('shardError', (error) => {
    state.lastDiscordLoginError = `Gateway shard error: ${error.message}`;
    console.error('Discord shard error:', error);
  });
  state.discordLoginStartedAt = new Date().toISOString();
  console.log(`Starting Discord login at ${state.discordLoginStartedAt}`);
  healthTimer = setTimeout(() => {
    console.warn(`Discord login still not ready after ${config.healthServerStartTimeoutMs}ms; starting health server for diagnostics.`);
    startHealthServer();
  }, config.healthServerStartTimeoutMs);
  client.login(config.token).catch((error) => {
    state.lastDiscordLoginError = `Login failed: ${error.message}`;
    console.error('Discord login failed:', error);
    startHealthServer();
  });
  return { client, app };
}

module.exports = { startBot };
