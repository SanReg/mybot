const express = require('express');

function createHealthApp({ client, voting, state }) {
  const app = express();
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      botReady: client.isReady(),
      discordLoginStartedAt: state.discordLoginStartedAt,
      discordLoginError: state.lastDiscordLoginError,
      activeVoteChannels: voting.getActiveCount(),
      timestamp: new Date().toISOString(),
    });
  });
  app.get('/ready', (_req, res) => {
    const ready = client.isReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'starting',
      botReady: ready,
      ...(!ready && {
        discordLoginStartedAt: state.discordLoginStartedAt,
        discordLoginError: state.lastDiscordLoginError,
      }),
      timestamp: new Date().toISOString(),
    });
  });
  return app;
}

module.exports = { createHealthApp };
