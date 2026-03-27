require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { createQuizModule } = require('./quiz');
const { createVotingModule } = require('./voting');

const PORT = Number(process.env.PORT || 3000);
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const TEST_GUILD_IDS = toIdSetFromMany(process.env.GUILD_IDS, process.env.GUILD_ID);

const QUIZ_MASTER_IDS = toIdSet(process.env.QUIZ_MASTER_IDS);
const VOTE_STARTER_IDS = toIdSet(process.env.VOTE_STARTER_IDS);
const VOTER_ROLE_ID = process.env.VOTER_ROLE_ID;
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const app = express();

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    botReady: client.isReady(),
    activeQuizChannels: ENABLE_QUIZ ? quiz.getActiveCount() : 0,
    activeVoteChannels: voting.getActiveCount(),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

client.once('clientReady', async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'Earning Slices...', type: ActivityType.Playing }],
    status: 'online',
  });

  const commands = [
    ...(ENABLE_QUIZ ? quiz.buildCommands() : []),
    ...voting.buildCommands(),
  ].map((c) => c.toJSON());

  if (TEST_GUILD_IDS.size > 0) {
    for (const guildId of TEST_GUILD_IDS) {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`Registered slash commands for guild ${guildId}`);
    }
  } else {
    await client.application.commands.set(commands);
    console.log('Registered global slash commands (can take time to appear).');
  }
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
  console.error('Discord client error:', error);
});

client.login(DISCORD_TOKEN);

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
