require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { createQuizModule } = require('./quiz');
const { createVotingModule } = require('./voting');
const { createEchoModule } = require('./echo');

const PORT = Number(process.env.PORT || 3000);
const HEALTH_SERVER_START_TIMEOUT_MS = Number(process.env.HEALTH_SERVER_START_TIMEOUT_MS || 25000);
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const TEST_GUILD_IDS = toIdSetFromMany(process.env.GUILD_IDS, process.env.GUILD_ID);

const QUIZ_MASTER_IDS = toIdSet(process.env.QUIZ_MASTER_IDS);
const VOTE_STARTER_IDS = toIdSet(process.env.VOTE_STARTER_IDS);
const VOTER_ROLE_ID = process.env.VOTER_ROLE_ID;
const ECHO_MASTER_IDS = toIdSet(process.env.ECHO_MASTER_IDS);
const QUIZ_TIMEOUT_SECONDS = Number(process.env.QUIZ_TIMEOUT_SECONDS || 600);
const ENABLE_QUIZ = process.env.ENABLE_QUIZ === 'true';

if (!DISCORD_TOKEN || !CLIENT_ID) {
  throw new Error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
}

if (!VOTER_ROLE_ID) {
  throw new Error('Missing VOTER_ROLE_ID in environment variables.');
}

const quiz = createQuizModule({
  quizMasterIds: QUIZ_MASTER_IDS,
  timeoutSeconds: QUIZ_TIMEOUT_SECONDS,
});

const voting = createVotingModule({
  voteStarterIds: VOTE_STARTER_IDS,
  voterRoleId: VOTER_ROLE_ID,
});

const echo = createEchoModule({
  echoMasterIds: ECHO_MASTER_IDS,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let discordLoginStartedAt = null;
let lastDiscordLoginError = null;
let healthServerStarted = false;

const app = express();

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    botReady: client.isReady(),
    discordLoginStartedAt,
    discordLoginError: lastDiscordLoginError,
    activeQuizChannels: ENABLE_QUIZ ? quiz.getActiveCount() : 0,
    activeVoteChannels: voting.getActiveCount(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (_req, res) => {
  if (!client.isReady()) {
    res.status(503).json({
      status: 'starting',
      botReady: false,
      discordLoginStartedAt,
      discordLoginError: lastDiscordLoginError,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  res.status(200).json({
    status: 'ready',
    botReady: true,
    timestamp: new Date().toISOString(),
  });
});

function startHealthServer() {
  if (healthServerStarted) {
    return;
  }

  app.listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}`);
  });

  healthServerStarted = true;
}

client.once('clientReady', async () => {
  lastDiscordLoginError = null;
  console.log(`Discord bot logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'Earning Slices...', type: ActivityType.Playing }],
    status: 'online',
  });

  const commands = [
    ...(ENABLE_QUIZ ? quiz.buildCommands() : []),
    ...voting.buildCommands(),
    ...echo.buildCommands(),
  ].map((c) => c.toJSON());

  // Always register globally so commands work in every guild where the bot is installed.
  await client.application.commands.set(commands);
  console.log('Registered global slash commands (can take time to appear).');

  // Optional fast registration for listed test guilds; failures should not crash startup.
  if (TEST_GUILD_IDS.size > 0) {
    for (const guildId of TEST_GUILD_IDS) {
      try {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(commands);
        console.log(`Registered slash commands for test guild ${guildId}`);
      } catch (error) {
        if (error && error.code === 10004) {
          console.warn(
            `Skipping unknown test guild ${guildId}. Remove it from GUILD_IDS if it is no longer valid.`
          );
          continue;
        }

        console.error(`Failed to register commands for test guild ${guildId}:`, error);
      }
    }
  }

  startHealthServer();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (ENABLE_QUIZ) {
      const quizHandled = await quiz.handleInteraction(interaction);
      if (quizHandled) {
        return;
      }
    }

    const voteHandled = await voting.handleInteraction(interaction);
    if (voteHandled) {
      return;
    }

    const echoHandled = await echo.handleInteraction(interaction);
    if (echoHandled) {
      return;
    }
  } catch (error) {
    console.error('interactionCreate error:', error);

    if (isExpiredInteractionError(error)) {
      return;
    }

    const content = 'Something went wrong while processing this command.';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: 64 }).catch(() => null);
    } else {
      await interaction.reply({ content, flags: 64 }).catch(() => null);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (!ENABLE_QUIZ) {
    return;
  }

  try {
    await quiz.handleMessage(message);
  } catch (error) {
    console.error('messageCreate error:', error);
  }
});

client.on('error', (error) => {
  lastDiscordLoginError = `Client error: ${error.message}`;
  console.error('Discord client error:', error);
});

client.on('shardError', (error) => {
  lastDiscordLoginError = `Gateway shard error: ${error.message}`;
  console.error('Discord shard error:', error);
});

discordLoginStartedAt = new Date().toISOString();
console.log(`Starting Discord login at ${discordLoginStartedAt}`);
setTimeout(() => {
  if (!healthServerStarted) {
    console.warn(
      `Discord login still not ready after ${HEALTH_SERVER_START_TIMEOUT_MS}ms; starting health server for diagnostics.`
    );
    startHealthServer();
  }
}, HEALTH_SERVER_START_TIMEOUT_MS);

client.login(DISCORD_TOKEN).catch((error) => {
  lastDiscordLoginError = `Login failed: ${error.message}`;
  console.error('Discord login failed:', error);
  startHealthServer();
});

function toIdSet(ids) {
  if (!ids) {
    return new Set();
  }

  return new Set(
    ids
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function toIdSetFromMany(...values) {
  const merged = new Set();

  for (const value of values) {
    const ids = toIdSet(value);
    for (const id of ids) {
      merged.add(id);
    }
  }

  return merged;
}

function isExpiredInteractionError(error) {
  return error && (error.code === 10062 || error.code === 40060);
}
