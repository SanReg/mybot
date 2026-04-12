const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const VOTE_STORE_FILE = path.join(process.cwd(), 'vote.json');
const MAX_MEMES = 10;
const REQUIRED_VOTES_PER_USER = 3;
const MEME_VOTE_AUDIT_CHANNEL_ID = '933715343199838328';

function createVotingModule({ voteStarterIds, voterRoleId }) {
  const activeVoteByGuild = new Map();
  const voteHistoryByGuild = new Map();

  loadPersistentState();
  restoreActiveVoteTimeouts();

  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('start-vote')
        .setDescription('Start a meme vote in this server.')
        .addIntegerOption((option) =>
          option
            .setName('duration')
            .setDescription('Vote duration in hours')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(168)
        )
        .addStringOption((option) =>
          option
            .setName('meme1')
            .setDescription('Reddit meme link 1')
            .setRequired(true)
            .setMaxLength(1000)
        )
        .addStringOption((option) =>
          option
            .setName('meme2')
            .setDescription('Reddit meme link 2')
            .setRequired(true)
            .setMaxLength(1000)
        )
        .addStringOption((option) => option.setName('meme3').setDescription('Reddit meme link 3').setMaxLength(1000))
        .addStringOption((option) => option.setName('meme4').setDescription('Reddit meme link 4').setMaxLength(1000))
        .addStringOption((option) => option.setName('meme5').setDescription('Reddit meme link 5').setMaxLength(1000))
        .addStringOption((option) => option.setName('meme6').setDescription('Reddit meme link 6').setMaxLength(1000))
        .addStringOption((option) => option.setName('meme7').setDescription('Reddit meme link 7').setMaxLength(1000))
        .addStringOption((option) => option.setName('meme8').setDescription('Reddit meme link 8').setMaxLength(1000))
        .addStringOption((option) => option.setName('meme9').setDescription('Reddit meme link 9').setMaxLength(1000))
        .addStringOption((option) => option.setName('meme10').setDescription('Reddit meme link 10').setMaxLength(1000)),
      new SlashCommandBuilder()
        .setName('my-votes')
        .setDescription('Show your submitted meme votes in the active server vote.'),
      new SlashCommandBuilder()
        .setName('end-vote')
        .setDescription('End the active meme vote in this server (vote starters only).'),
      new SlashCommandBuilder()
        .setName('vote-results')
        .setDescription('Show current meme vote standing for this server (vote starters only).'),
      new SlashCommandBuilder()
        .setName('vote-details')
        .setDescription('Show per-user meme vote details for this server (vote starters only).'),
    ];
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith('memevote:')) {
        return false;
      }

      await handleMemeVoteButton(interaction);
      return true;
    }

    if (!interaction.isChatInputCommand()) {
      return false;
    }

    if (interaction.commandName === 'start-vote') {
      await handleStartVoteCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'my-votes') {
      await handleMyVotesCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'end-vote') {
      await handleEndVoteCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'vote-results') {
      await handleVoteResultsCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'vote-details') {
      await handleVoteDetailsCommand(interaction);
      return true;
    }

    return false;
  }

  async function handleStartVoteCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    if (!voteStarterIds.has(interaction.user.id)) {
      await interaction.reply({
        content: 'You are not allowed to start votes.',
        flags: 64,
      });
      return;
    }

    const guildId = interaction.guildId;
    const existing = activeVoteByGuild.get(guildId);
    if (existing && !existing.closed) {
      await interaction.reply({
        content: 'A vote is already active in this server.',
        flags: 64,
      });
      return;
    }

    const memeLinks = collectMemeLinks(interaction);
    const invalidLink = memeLinks.find((link) => !isLikelyHttpUrl(link));
    if (invalidLink) {
      await interaction.reply({
        content: `Invalid meme link: ${invalidLink}`,
        flags: 64,
      });
      return;
    }

    const duration = interaction.options.getInteger('duration', true);
    const remainingMs = duration * 60 * 60 * 1000;
    const endAt = Date.now() + remainingMs;
    const endsOnEpochSeconds = Math.floor(endAt / 1000);

    const memes = memeLinks.map((link, idx) => ({
      index: idx + 1,
      link,
      messageId: null,
    }));

    const vote = {
      id: `${guildId}-${Date.now()}`,
      guildId,
      startChannelId: interaction.channelId,
      startedById: interaction.user.id,
      startedByUsername: interaction.user.username,
      createdAt: Date.now(),
      endAt,
      memes,
      votesByUser: new Map(),
      votersByMeme: new Map(memes.map((m) => [m.index, new Set()])),
      voteLog: [],
      closed: false,
      timeoutHandle: null,
    };

    vote.timeoutHandle = setTimeout(async () => {
      const channel = await interaction.client.channels.fetch(vote.startChannelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        await closeVote(guildId, channel, 'Voting window finished.');
      } else {
        vote.closed = true;
        activeVoteByGuild.delete(guildId);
        saveVoteHistory(guildId, vote);
        savePersistentState();
      }
    }, remainingMs);

    activeVoteByGuild.set(guildId, vote);
    savePersistentState();

    await interaction.reply({
      content:
        `Meme vote started by ${interaction.user}.\n` +
        `Duration: **${duration} hour(s)**\n` +
        `Ends on: <t:${endsOnEpochSeconds}:F> (<t:${endsOnEpochSeconds}:R>)\n` +
        `Memes in this round: **${memes.length}**\n` +
        `Eligible users can vote using the buttons below. Each user can vote exactly ${REQUIRED_VOTES_PER_USER} times for different memes.`,
    });

    for (const meme of memes) {
      const button = new ButtonBuilder()
        .setCustomId(buildMemeButtonCustomId(vote.id, meme.index))
        .setLabel(`Vote Meme #${meme.index}`)
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);

      const posted = await interaction.channel.send({
        content: `**Meme #${meme.index}**\n${meme.link}\nClick the button below to vote for this meme.`,
        components: [row],
      });

      meme.messageId = posted.id;
    }

    savePersistentState();
  }

  async function handleMemeVoteButton(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This button can only be used in a server.',
        flags: 64,
      });
      return;
    }

    if (!interaction.member || !interaction.member.roles || !interaction.member.roles.cache) {
      await interaction.reply({
        content: 'Could not validate your server role.',
        flags: 64,
      });
      return;
    }

    if (!interaction.member.roles.cache.has(voterRoleId)) {
      await interaction.reply({
        content: 'You do not have the required role to vote.',
        flags: 64,
      });
      return;
    }

    const parsed = parseMemeButtonCustomId(interaction.customId);
    if (!parsed) {
      await interaction.reply({
        content: 'Invalid vote button.',
        flags: 64,
      });
      return;
    }

    const guildId = interaction.guildId;
    const vote = activeVoteByGuild.get(guildId);
    if (!vote || vote.closed) {
      await interaction.reply({
        content: 'There is no active vote in this server.',
        flags: 64,
      });
      return;
    }

    if (parsed.voteId !== vote.id) {
      await interaction.reply({
        content: 'This vote button belongs to an older vote round.',
        flags: 64,
      });
      return;
    }

    if (Date.now() > vote.endAt) {
      await closeVote(guildId, interaction.channel, 'Voting window finished.');
      await interaction.reply({
        content: 'This vote already ended.',
        flags: 64,
      });
      return;
    }

    const meme = vote.memes.find((item) => item.index === parsed.memeIndex);
    if (!meme) {
      await interaction.reply({
        content: 'Selected meme was not found in this vote.',
        flags: 64,
      });
      return;
    }

    const userVotes = vote.votesByUser.get(interaction.user.id) || new Set();

    if (userVotes.has(meme.index)) {
      await interaction.reply({
        content: `You already voted for Meme #${meme.index}. Choose a different meme.`,
        flags: 64,
      });
      return;
    }

    if (userVotes.size >= REQUIRED_VOTES_PER_USER) {
      await interaction.reply({
        content: `You already used your ${REQUIRED_VOTES_PER_USER} votes.`,
        flags: 64,
      });
      return;
    }

    userVotes.add(meme.index);
    vote.votesByUser.set(interaction.user.id, userVotes);

    const votersForMeme = vote.votersByMeme.get(meme.index) || new Set();
    votersForMeme.add(interaction.user.id);
    vote.votersByMeme.set(meme.index, votersForMeme);

    vote.voteLog.push({
      userId: interaction.user.id,
      username: interaction.user.username,
      memeIndex: meme.index,
      memeLink: meme.link,
      votedAt: Date.now(),
      source: 'button',
    });

    savePersistentState();

    const remaining = REQUIRED_VOTES_PER_USER - userVotes.size;

    await interaction.reply({
      content:
        `Vote recorded for Meme #${meme.index}.\n` +
        `Link: ${meme.link}\n` +
        `Remaining votes: **${remaining}** (must be different memes).`,
      flags: 64,
    });

    await logToAuditChannel(
      interaction.client,
      MEME_VOTE_AUDIT_CHANNEL_ID,
      `[MEME_VOTE] user=${interaction.user.tag} (${interaction.user.id}) guild=${interaction.guildId} meme=#${meme.index} link=${meme.link}`
    );
  }

  async function handleVoteResultsCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    const isStarter = voteStarterIds.has(interaction.user.id);
    if (!isStarter) {
      await interaction.reply({
        content: 'You are not allowed to view vote results.',
        flags: 64,
      });
      return;
    }

    const resolvedVote = getCurrentOrLatestVote(interaction.guildId);
    if (!resolvedVote) {
      await interaction.reply({
        content: 'No vote data found for this server.',
        flags: 64,
      });
      return;
    }

    const { vote, isActive } = resolvedVote;

    const lines = vote.memes.map((meme) => {
      const voters = vote.votersByMeme.get(meme.index) || new Set();
      return `#${meme.index}: ${voters.size} vote(s) - ${meme.link}`;
    });

    await interaction.reply({
      content: `${isActive ? 'Current vote results' : 'Latest closed vote results'}\n${lines.join('\n')}`,
      flags: 64,
    });
  }

  async function handleMyVotesCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    const vote = activeVoteByGuild.get(interaction.guildId);
    if (!vote || vote.closed) {
      await interaction.reply({
        content: 'There is no active vote in this server.',
        flags: 64,
      });
      return;
    }

    const userVotes = vote.votesByUser.get(interaction.user.id) || new Set();
    const selected = [...userVotes]
      .sort((a, b) => a - b)
      .map((index) => {
        const meme = vote.memes.find((entry) => entry.index === index);
        return meme ? `#${index}: ${meme.link}` : `#${index}`;
      });

    const remaining = Math.max(0, REQUIRED_VOTES_PER_USER - userVotes.size);

    await interaction.reply({
      content:
        `Your meme votes:\n${selected.length ? selected.join('\n') : 'none'}\n` +
        `Used: ${userVotes.size}/${REQUIRED_VOTES_PER_USER}\n` +
        `Remaining: ${remaining}`,
      flags: 64,
    });
  }

  async function handleVoteDetailsCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    const isStarter = voteStarterIds.has(interaction.user.id);
    if (!isStarter) {
      await interaction.reply({
        content: 'You are not allowed to view vote details.',
        flags: 64,
      });
      return;
    }

    const resolvedVote = getCurrentOrLatestVote(interaction.guildId);
    if (!resolvedVote) {
      await interaction.reply({
        content: 'No vote data found for this server.',
        flags: 64,
      });
      return;
    }

    const { vote, isActive } = resolvedVote;

    const details = [...vote.votesByUser.entries()]
      .map(([userId, votesSet]) => {
        const userVoteEntries = vote.voteLog.filter((entry) => entry.userId === userId);
        const latestUsername = userVoteEntries.length
          ? userVoteEntries[userVoteEntries.length - 1].username
          : 'unknown';

        const votedMemes = [...votesSet]
          .sort((a, b) => a - b)
          .map((index) => {
            const meme = vote.memes.find((entry) => entry.index === index);
            return meme ? `#${index}` : `#${index}`;
          })
          .join(', ');

        return `- ${latestUsername} (<@${userId}>): ${votesSet.size} vote(s) [${votedMemes || 'none'}]`;
      })
      .sort((a, b) => a.localeCompare(b));

    const content =
      details.length > 0
        ? `${isActive ? 'Vote details (per user)' : 'Latest closed vote details (per user)'}\n${details.join('\n')}`
        : 'No votes recorded yet.';

    await interaction.reply({
      content,
      flags: 64,
    });
  }

  async function handleEndVoteCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    const isStarter = voteStarterIds.has(interaction.user.id);
    if (!isStarter) {
      await interaction.reply({
        content: 'You are not allowed to end votes.',
        flags: 64,
      });
      return;
    }

    const vote = activeVoteByGuild.get(interaction.guildId);
    if (!vote || vote.closed) {
      await interaction.reply({
        content: 'There is no active vote in this server.',
        flags: 64,
      });
      return;
    }

    await closeVote(
      interaction.guildId,
      interaction.channel,
      `Vote ended manually by <@${interaction.user.id}>.`
    );

    await interaction.reply({
      content: 'Vote ended successfully.',
      flags: 64,
    });
  }

  async function closeVote(guildId, channel, reason) {
    const vote = activeVoteByGuild.get(guildId);
    if (!vote || vote.closed) {
      return;
    }

    vote.closed = true;
    activeVoteByGuild.delete(guildId);

    if (vote.timeoutHandle) {
      clearTimeout(vote.timeoutHandle);
    }

    saveVoteHistory(guildId, vote);
    savePersistentState();

    if (channel && channel.isTextBased()) {
      await channel.send(
        `${reason}\nVote is now closed. Authorized users can view results privately with /vote-results.`
      );
    }
  }

  function saveVoteHistory(guildId, vote) {
    const history = voteHistoryByGuild.get(guildId) || [];

    history.push({
      id: vote.id,
      guildId: vote.guildId,
      startChannelId: vote.startChannelId,
      startedById: vote.startedById,
      startedByUsername: vote.startedByUsername,
      createdAt: vote.createdAt,
      closedAt: Date.now(),
      endAt: vote.endAt,
      memes: vote.memes.map((m) => ({ index: m.index, link: m.link, messageId: m.messageId || null })),
      voteLog: [...vote.voteLog],
    });

    voteHistoryByGuild.set(guildId, history);
  }

  function getCurrentOrLatestVote(guildId) {
    const activeVote = activeVoteByGuild.get(guildId);
    if (activeVote && !activeVote.closed) {
      return { vote: activeVote, isActive: true };
    }

    const history = voteHistoryByGuild.get(guildId) || [];
    if (history.length === 0) {
      return null;
    }

    const latestHistory = history[history.length - 1];
    return {
      vote: historyEntryToVoteView(latestHistory),
      isActive: false,
    };
  }

  function historyEntryToVoteView(historyEntry) {
    const voteLog = historyEntry.voteLog || [];
    const memes = normalizeMemesForHistory(historyEntry);

    const votersByMeme = new Map(memes.map((meme) => [meme.index, new Set()]));
    const votesByUser = new Map();

    for (const entry of voteLog) {
      const memeIndex = entry.memeIndex ?? entry.number;
      if (!Number.isFinite(memeIndex)) {
        continue;
      }

      if (!votersByMeme.has(memeIndex)) {
        votersByMeme.set(memeIndex, new Set());
      }
      votersByMeme.get(memeIndex).add(entry.userId);

      const existingVotes = votesByUser.get(entry.userId) || new Set();
      existingVotes.add(memeIndex);
      votesByUser.set(entry.userId, existingVotes);
    }

    return {
      memes,
      voteLog,
      votersByMeme,
      votesByUser,
      closed: true,
    };
  }

  function savePersistentState() {
    const payload = {
      version: 2,
      activeVotesByGuild: Object.fromEntries(
        [...activeVoteByGuild.entries()].map(([guildId, vote]) => [guildId, serializeVote(vote)])
      ),
      voteHistoryByGuild: Object.fromEntries(voteHistoryByGuild),
    };

    try {
      fs.writeFileSync(VOTE_STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to persist vote data:', error);
    }
  }

  function loadPersistentState() {
    if (!fs.existsSync(VOTE_STORE_FILE)) {
      return;
    }

    try {
      const raw = fs.readFileSync(VOTE_STORE_FILE, 'utf8');
      const data = JSON.parse(raw);

      const activeVotesByGuild = data.activeVotesByGuild || {};
      for (const [guildId, serializedVote] of Object.entries(activeVotesByGuild)) {
        const vote = deserializeVote(serializedVote);
        if (vote) {
          activeVoteByGuild.set(guildId, vote);
        }
      }

      const persistedHistory = data.voteHistoryByGuild || {};
      for (const [guildId, entries] of Object.entries(persistedHistory)) {
        voteHistoryByGuild.set(guildId, Array.isArray(entries) ? entries : []);
      }
    } catch (error) {
      console.error('Failed to load vote data:', error);
    }
  }

  function restoreActiveVoteTimeouts() {
    for (const [guildId, vote] of activeVoteByGuild.entries()) {
      const remainingMs = vote.endAt - Date.now();

      if (remainingMs <= 0) {
        vote.closed = true;
        activeVoteByGuild.delete(guildId);
        saveVoteHistory(guildId, vote);
        continue;
      }

      vote.timeoutHandle = setTimeout(() => {
        const activeVote = activeVoteByGuild.get(guildId);
        if (!activeVote || activeVote.id !== vote.id) {
          return;
        }

        activeVote.closed = true;
        activeVoteByGuild.delete(guildId);
        saveVoteHistory(guildId, activeVote);
        savePersistentState();
      }, remainingMs);
    }

    savePersistentState();
  }

  function serializeVote(vote) {
    return {
      id: vote.id,
      guildId: vote.guildId,
      startChannelId: vote.startChannelId,
      startedById: vote.startedById,
      startedByUsername: vote.startedByUsername,
      createdAt: vote.createdAt,
      endAt: vote.endAt,
      memes: vote.memes.map((m) => ({ index: m.index, link: m.link, messageId: m.messageId || null })),
      voteLog: [...vote.voteLog],
      closed: vote.closed,
      votesByUser: Object.fromEntries(
        [...vote.votesByUser.entries()].map(([userId, values]) => [userId, [...values]])
      ),
      votersByMeme: Object.fromEntries(
        [...vote.votersByMeme.entries()].map(([memeIndex, values]) => [memeIndex, [...values]])
      ),
    };
  }

  function deserializeVote(data) {
    const memes = normalizeMemes(data);
    if (memes.length < 2) {
      return null;
    }

    const votersByMeme = new Map(memes.map((meme) => [meme.index, new Set()]));

    for (const [memeIndex, values] of Object.entries(data.votersByMeme || {})) {
      votersByMeme.set(Number(memeIndex), new Set(values));
    }

    const votesByUser = new Map(
      Object.entries(data.votesByUser || {}).map(([userId, values]) => [userId, new Set(values)])
    );

    return {
      id: data.id,
      guildId: data.guildId,
      startChannelId: data.startChannelId,
      startedById: data.startedById,
      startedByUsername: data.startedByUsername,
      createdAt: data.createdAt,
      endAt: data.endAt,
      memes,
      votesByUser,
      votersByMeme,
      voteLog: Array.isArray(data.voteLog) ? data.voteLog : [],
      closed: Boolean(data.closed),
      timeoutHandle: null,
    };
  }

  return {
    buildCommands,
    handleInteraction,
    getActiveCount: () => activeVoteByGuild.size,
  };
}

function collectMemeLinks(interaction) {
  const links = [];
  for (let i = 1; i <= MAX_MEMES; i += 1) {
    const value = interaction.options.getString(`meme${i}`);
    if (!value) {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    links.push(toVxRedditUrl(trimmed));
  }

  return links;
}

function toVxRedditUrl(url) {
  const match = url.match(/^https?:\/\/(?:www\.|old\.|np\.)?reddit\.com(\/.*)$/i);
  if (!match) {
    return url;
  }

  return `https://vxreddit.com${match[1]}`;
}

function isLikelyHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value);
}

function buildMemeButtonCustomId(voteId, memeIndex) {
  return `memevote:${voteId}:${memeIndex}`;
}

function parseMemeButtonCustomId(customId) {
  const parts = customId.split(':');
  if (parts.length < 3 || parts[0] !== 'memevote') {
    return null;
  }

  const memeIndex = Number(parts[parts.length - 1]);
  if (!Number.isInteger(memeIndex) || memeIndex <= 0) {
    return null;
  }

  const voteId = parts.slice(1, parts.length - 1).join(':');
  if (!voteId) {
    return null;
  }

  return {
    voteId,
    memeIndex,
  };
}

function normalizeMemes(data) {
  if (Array.isArray(data.memes) && data.memes.length > 0) {
    return data.memes
      .map((entry, idx) => ({
        index: Number.isInteger(entry.index) ? entry.index : idx + 1,
        link: String(entry.link || '').trim(),
        messageId: entry.messageId || null,
      }))
      .filter((entry) => entry.link.length > 0);
  }

  if (Number.isInteger(data.maxNumber) && data.maxNumber > 0) {
    return Array.from({ length: data.maxNumber }, (_, idx) => ({
      index: idx + 1,
      link: `Meme #${idx + 1}`,
      messageId: null,
    }));
  }

  return [];
}

function normalizeMemesForHistory(historyEntry) {
  if (Array.isArray(historyEntry.memes) && historyEntry.memes.length > 0) {
    return historyEntry.memes
      .map((entry, idx) => ({
        index: Number.isInteger(entry.index) ? entry.index : idx + 1,
        link: String(entry.link || '').trim() || `Meme #${idx + 1}`,
      }))
      .filter((entry) => entry.index > 0);
  }

  if (Number.isInteger(historyEntry.maxNumber) && historyEntry.maxNumber > 0) {
    return Array.from({ length: historyEntry.maxNumber }, (_, idx) => ({
      index: idx + 1,
      link: `Meme #${idx + 1}`,
    }));
  }

  return [];
}

async function logToAuditChannel(client, channelId, content) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    await channel.send({ content });
  } catch (error) {
    console.error(`Failed to send meme vote audit log to channel ${channelId}:`, error);
  }
}

module.exports = {
  createVotingModule,
};
