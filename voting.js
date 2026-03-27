const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

const VOTE_STORE_FILE = path.join(process.cwd(), 'vote.json');

function createVotingModule({ voteStarterIds, voterRoleId }) {
  const activeVoteByGuild = new Map();
  const voteHistoryByGuild = new Map();

  loadPersistentState();
  restoreActiveVoteTimeouts();

  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('start-vote')
        .setDescription('Start a vote in this server.')
        .addIntegerOption((option) =>
          option
            .setName('duration')
            .setDescription('Vote duration in hours')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(168)
        )
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('Maximum vote number (1..n)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(1000)
        ),
      new SlashCommandBuilder()
        .setName('vote')
        .setDescription('Vote for a number in the active server vote.')
        .addIntegerOption((option) =>
          option
            .setName('number')
            .setDescription('Your chosen number (1..n)')
            .setRequired(true)
            .setMinValue(1)
        ),
      new SlashCommandBuilder()
        .setName('my-votes')
        .setDescription('Show your submitted votes in the active server vote.'),
      new SlashCommandBuilder()
        .setName('vote-results')
        .setDescription('Show current vote standing for this server.'),
      new SlashCommandBuilder()
        .setName('vote-details')
        .setDescription('Show per-user vote counts for this server.'),
    ];
  }

  async function handleInteraction(interaction) {
    if (interaction.commandName === 'start-vote') {
      await handleStartVoteCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'vote') {
      await handleVoteCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'my-votes') {
      await handleMyVotesCommand(interaction);
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

    const duration = interaction.options.getInteger('duration', true);
    const remainingMs = duration * 60 * 60 * 1000;
    const endAt = Date.now() + remainingMs;
    const endsOnEpochSeconds = Math.floor(endAt / 1000);

    const n = interaction.options.getInteger('number', true);

    const vote = {
      id: `${guildId}:${Date.now()}`,
      guildId,
      startChannelId: interaction.channelId,
      startedById: interaction.user.id,
      startedByUsername: interaction.user.username,
      createdAt: Date.now(),
      endAt,
      maxNumber: n,
      votesByUser: new Map(),
      votersByNumber: new Map(Array.from({ length: n }, (_, i) => [i + 1, new Set()])),
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
        `Vote started by ${interaction.user}.\n` +
        `Duration: **${duration} hour(s)**\n` +
        `Ends on: <t:${endsOnEpochSeconds}:F> (<t:${endsOnEpochSeconds}:R>)\n` +
        `Valid numbers: **1 to ${n}**\n` +
        'Eligible users can vote from any channel in this server with /vote number:<n>. Each user can vote exactly three times for three different numbers.',
    });
  }

  async function handleVoteCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
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

    const guildId = interaction.guildId;
    const vote = activeVoteByGuild.get(guildId);
    if (!vote || vote.closed) {
      await interaction.reply({
        content: 'There is no active vote in this server.',
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

    const number = interaction.options.getInteger('number', true);
    if (number < 1 || number > vote.maxNumber) {
      await interaction.reply({
        content: `Invalid number. Choose between 1 and ${vote.maxNumber}.`,
        flags: 64,
      });
      return;
    }

    const userVotes = vote.votesByUser.get(interaction.user.id) || new Set();

    if (userVotes.has(number)) {
      await interaction.reply({
        content: `You already voted for number ${number}. Choose a different number.`,
        flags: 64,
      });
      return;
    }

    if (userVotes.size >= 3) {
      await interaction.reply({
        content: 'You already used your 3 votes.',
        flags: 64,
      });
      return;
    }

    userVotes.add(number);
    vote.votesByUser.set(interaction.user.id, userVotes);

    const votersForNumber = vote.votersByNumber.get(number) || new Set();
    votersForNumber.add(interaction.user.id);
    vote.votersByNumber.set(number, votersForNumber);

    vote.voteLog.push({
      userId: interaction.user.id,
      username: interaction.user.username,
      number,
      votedAt: Date.now(),
    });

    savePersistentState();

    const remaining = 3 - userVotes.size;

    await interaction.reply({
      content:
        `Vote recorded: **${number}**.\n` +
        `Remaining votes: **${remaining}** (must be different valid numbers).`,
      flags: 64,
    });
  }

  async function handleVoteResultsCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
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

    const lines = [];
    for (let i = 1; i <= vote.maxNumber; i += 1) {
      const voterIds = vote.votersByNumber.get(i) || new Set();
      lines.push(`${i}: ${voterIds.size} vote(s)`);
    }

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
    const numbers = [...userVotes].sort((a, b) => a - b);
    const remaining = Math.max(0, 3 - userVotes.size);

    await interaction.reply({
      content:
        `Your votes: ${numbers.length ? numbers.join(', ') : 'none'}\n` +
        `Used: ${userVotes.size}/3\n` +
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
        const numbers = [...votesSet].sort((a, b) => a - b);
        return `- ${latestUsername} (<@${userId}>): ${votesSet.size} vote(s) [${numbers.join(', ') || 'none'}]`;
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

    await channel.send(
      `${reason}\nVote is now closed. Authorized users can view results privately with /vote-results.`
    );
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
      maxNumber: vote.maxNumber,
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
    const votersByNumber = new Map();
    for (let i = 1; i <= historyEntry.maxNumber; i += 1) {
      votersByNumber.set(i, new Set());
    }

    const votesByUser = new Map();
    for (const entry of voteLog) {
      if (!votersByNumber.has(entry.number)) {
        votersByNumber.set(entry.number, new Set());
      }
      votersByNumber.get(entry.number).add(entry.userId);

      const existingVotes = votesByUser.get(entry.userId) || new Set();
      existingVotes.add(entry.number);
      votesByUser.set(entry.userId, existingVotes);
    }

    return {
      maxNumber: historyEntry.maxNumber,
      voteLog,
      votersByNumber,
      votesByUser,
      closed: true,
    };
  }

  function savePersistentState() {
    const payload = {
      version: 1,
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
        activeVoteByGuild.set(guildId, vote);
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
      maxNumber: vote.maxNumber,
      voteLog: [...vote.voteLog],
      closed: vote.closed,
      votesByUser: Object.fromEntries(
        [...vote.votesByUser.entries()].map(([userId, values]) => [userId, [...values]])
      ),
      votersByNumber: Object.fromEntries(
        [...vote.votersByNumber.entries()].map(([number, values]) => [number, [...values]])
      ),
    };
  }

  function deserializeVote(data) {
    const votersByNumber = new Map();
    for (let i = 1; i <= data.maxNumber; i += 1) {
      votersByNumber.set(i, new Set());
    }

    for (const [number, values] of Object.entries(data.votersByNumber || {})) {
      votersByNumber.set(Number(number), new Set(values));
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
      maxNumber: data.maxNumber,
      votesByUser,
      votersByNumber,
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

module.exports = {
  createVotingModule,
};
