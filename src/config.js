const path = require('node:path');

function toIdSet(...values) {
  return new Set(values.flatMap((value) => (value || '').split(',').map((id) => id.trim()).filter(Boolean)));
}

function loadConfig(env = process.env) {
  for (const name of ['DISCORD_TOKEN']) {
    if (!env[name]) throw new Error(`Missing ${name} in environment variables.`);
  }
  const pollSeconds = Number(env.REDDIT_POLL_SECONDS || 300);
  const relayDefaults = {
    maxPostAgeMs: Math.max(1, Number(env.REDDIT_MAX_POST_AGE_MINUTES || 10)) * 60000,
    memoryTtlMs: Math.max(1, Number(env.REDDIT_MEMORY_TTL_MINUTES || 15)) * 60000,
  };
  return {
    token: env.DISCORD_TOKEN,
    testGuildIds: toIdSet(env.GUILD_IDS, env.GUILD_ID),
    port: Number(env.PORT || 3000),
    healthServerStartTimeoutMs: Number(env.HEALTH_SERVER_START_TIMEOUT_MS || 25000),
    voting: {
      voteStarterIds: toIdSet(env.VOTE_STARTER_IDS),
      dbFile: env.DB_FILE || path.join(env.DB_DIR || '/root/data/mybot', 'vote.db'),
    },
    echo: { echoMasterIds: toIdSet(env.ECHO_MASTER_IDS) },
    lock: {
      lockManagerRoleIds: toIdSet(env.LOCK_MANAGER_ROLE_IDS),
      lockChannelId: env.LOCK_CHANNEL_ID,
      lockedOutRoleId: env.LOCKED_ROLE_ID,
    },
    reddit: {
      ...relayDefaults,
      feedUrl: env.REDDIT_FEED_URL || 'https://www.reddit.com/r/ecils/new/.rss',
      channelId: env.REDDIT_CHANNEL_ID || '931635666922651719',
      pollIntervalMs: Math.max(15, pollSeconds) * 1000,
    },
    redditArt: {
      ...relayDefaults,
      feedUrl: env.REDDIT_ART_FEED_URL || 'https://www.reddit.com/r/Ecils_Art_Submissions/new/.rss',
      channelId: env.REDDIT_ART_CHANNEL_ID || '1505542489413648435',
      pollIntervalMs: Math.max(15, Number(env.REDDIT_ART_POLL_SECONDS || pollSeconds)) * 1000,
    },
  };
}

module.exports = { loadConfig };
