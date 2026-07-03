const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// The database lives on a persistent volume so it survives container rebuilds
// and restarts. DB_FILE overrides the full path; DB_DIR overrides just the
// directory. Defaults to the mounted volume at /data/mybot.
const DB_DIR = process.env.DB_DIR || '/root/data/mybot';
const DB_FILE = process.env.DB_FILE || path.join(DB_DIR, 'vote.db');
const MAX_MEMES = 10;
const REQUIRED_VOTES_PER_USER = 3;
const MEME_VOTE_AUDIT_GUILD_ID = '931174322989580308';
const MEME_VOTE_AUDIT_CHANNEL_ID = '933715343199838328';
const VOTE_TYPES = ['meme', 'art'];

function normalizeVoteType(rawType) {
  return String(rawType || '').toLowerCase() === 'art' ? 'art' : 'meme';
}

function activeKey(guildId, type) {
  return `${guildId}:${type}`;
}

function createVotingModule({ voteStarterIds, voterRoleId }) {
  // Active votes are keyed by `${guildId}:${type}` so a meme round and an art
  // round can run concurrently in the same guild.
  const activeVotes = new Map();

  const db = openDatabase();
  loadActiveVotes();

  // -------------------------------------------------------------------------
  // SQLite layer
  // -------------------------------------------------------------------------

  function openDatabase() {
    // Ensure the persistent directory exists so opening the DB never fails on
    // a fresh volume / first boot.
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const database = new DatabaseSync(DB_FILE);
    database.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        type TEXT NOT NULL,
        start_channel_id TEXT,
        started_by_id TEXT,
        started_by_username TEXT,
        created_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0,
        closed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS vote_memes (
        vote_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        link TEXT NOT NULL,
        message_id TEXT,
        PRIMARY KEY (vote_id, idx)
      );
      CREATE TABLE IF NOT EXISTS vote_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vote_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        meme_index INTEGER NOT NULL,
        meme_link TEXT,
        voted_at INTEGER NOT NULL,
        source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_vote_log_vote ON vote_log (vote_id);
      CREATE INDEX IF NOT EXISTS idx_votes_lookup ON votes (guild_id, type, closed);
    `);
    return database;
  }

  function persistVoteRow(vote) {
    db.prepare(
      `INSERT INTO votes
         (id, guild_id, type, start_channel_id, started_by_id, started_by_username,
          created_at, end_at, closed, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start_channel_id = excluded.start_channel_id,
         end_at = excluded.end_at,
         closed = excluded.closed,
         closed_at = excluded.closed_at`
    ).run(
      vote.id,
      vote.guildId,
      vote.type,
      vote.startChannelId || null,
      vote.startedById || null,
      vote.startedByUsername || null,
      vote.createdAt,
      vote.endAt,
      vote.closed ? 1 : 0,
      vote.closedAt || null
    );

    const upsertMeme = db.prepare(
      `INSERT INTO vote_memes (vote_id, idx, link, message_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(vote_id, idx) DO UPDATE SET
         link = excluded.link,
         message_id = excluded.message_id`
    );
    for (const meme of vote.memes) {
      upsertMeme.run(vote.id, meme.index, meme.link, meme.messageId || null);
    }
  }

  function appendVoteLog(voteId, entry) {
    db.prepare(
      `INSERT INTO vote_log (vote_id, user_id, username, meme_index, meme_link, voted_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      voteId,
      entry.userId,
      entry.username || null,
      entry.memeIndex,
      entry.memeLink || null,
      entry.votedAt,
      entry.source || null
    );
  }

  function markVoteClosed(voteId, closedAt) {
    db.prepare(`UPDATE votes SET closed = 1, closed_at = ? WHERE id = ?`).run(closedAt, voteId);
  }

  function deleteUserVoteLog(voteId, userId) {
    const result = db
      .prepare(`DELETE FROM vote_log WHERE vote_id = ? AND user_id = ?`)
      .run(voteId, userId);
    return Number(result.changes || 0);
  }

  function readMemes(voteId) {
    const rows = db
      .prepare(`SELECT idx, link, message_id FROM vote_memes WHERE vote_id = ? ORDER BY idx ASC`)
      .all(voteId);
    return rows.map((row) => ({
      index: Number(row.idx),
      link: String(row.link || ''),
      messageId: row.message_id || null,
    }));
  }

  function readVoteLog(voteId) {
    const rows = db
      .prepare(
        `SELECT user_id, username, meme_index, meme_link, voted_at, source
         FROM vote_log WHERE vote_id = ? ORDER BY id ASC`
      )
      .all(voteId);
    return rows.map((row) => ({
      userId: String(row.user_id),
      username: row.username || 'unknown',
      memeIndex: Number(row.meme_index),
      memeLink: row.meme_link || '',
      votedAt: Number(row.voted_at),
      source: row.source || null,
    }));
  }

  // Rebuild the derived per-user / per-meme tallies from the immutable vote log.
  function buildTallies(memes, voteLog) {
    const votersByMeme = new Map(memes.map((meme) => [meme.index, new Set()]));
    const votesByUser = new Map();

    for (const entry of voteLog) {
      const memeIndex = entry.memeIndex;
      if (!Number.isFinite(memeIndex)) {
        continue;
      }
      if (!votersByMeme.has(memeIndex)) {
        votersByMeme.set(memeIndex, new Set());
      }
      votersByMeme.get(memeIndex).add(entry.userId);

      const existing = votesByUser.get(entry.userId) || new Set();
      existing.add(memeIndex);
      votesByUser.set(entry.userId, existing);
    }

    return { votersByMeme, votesByUser };
  }

  function rowToVote(row) {
    const memes = readMemes(row.id);
    const voteLog = readVoteLog(row.id);
    const { votersByMeme, votesByUser } = buildTallies(memes, voteLog);

    return {
      id: row.id,
      guildId: String(row.guild_id),
      type: normalizeVoteType(row.type),
      startChannelId: row.start_channel_id || null,
      startedById: row.started_by_id || null,
      startedByUsername: row.started_by_username || null,
      createdAt: Number(row.created_at),
      endAt: Number(row.end_at),
      closed: Boolean(row.closed),
      closedAt: row.closed_at != null ? Number(row.closed_at) : null,
      memes,
      voteLog,
      votersByMeme,
      votesByUser,
      timeoutHandle: null,
    };
  }

  function loadActiveVotes() {
    const rows = db.prepare(`SELECT * FROM votes WHERE closed = 0`).all();
    for (const row of rows) {
      const vote = rowToVote(row);
      if (vote.memes.length < 2) {
        continue;
      }

      const remainingMs = vote.endAt - Date.now();
      if (remainingMs <= 0) {
        // Window already elapsed while the bot was offline; close it out.
        vote.closed = true;
        vote.closedAt = Date.now();
        markVoteClosed(vote.id, vote.closedAt);
        continue;
      }

      vote.timeoutHandle = setTimeout(() => {
        const stored = getActiveVote(vote.guildId, vote.type);
        if (!stored || stored.id !== vote.id) {
          return;
        }
        stored.closed = true;
        stored.closedAt = Date.now();
        markVoteClosed(stored.id, stored.closedAt);
        activeVotes.delete(activeKey(stored.guildId, stored.type));
      }, remainingMs);

      activeVotes.set(activeKey(vote.guildId, vote.type), vote);
    }
  }

  function getLatestClosedVote(guildId, type) {
    const row = db
      .prepare(
        `SELECT * FROM votes
         WHERE guild_id = ? AND type = ? AND closed = 1
         ORDER BY closed_at DESC, created_at DESC
         LIMIT 1`
      )
      .get(guildId, type);
    return row ? rowToVote(row) : null;
  }

  // -------------------------------------------------------------------------
  // In-memory active-vote helpers
  // -------------------------------------------------------------------------

  function getActiveVote(guildId, type) {
    const vote = activeVotes.get(activeKey(guildId, type));
    return vote && !vote.closed ? vote : null;
  }

  function findActiveVoteById(guildId, voteId) {
    for (const type of VOTE_TYPES) {
      const vote = getActiveVote(guildId, type);
      if (vote && vote.id === voteId) {
        return vote;
      }
    }
    return null;
  }

  function getCurrentOrLatestVote(guildId, type) {
    const active = getActiveVote(guildId, type);
    if (active) {
      return { vote: active, isActive: true };
    }

    const closed = getLatestClosedVote(guildId, type);
    if (closed) {
      return { vote: closed, isActive: false };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  function addTypeOption(command) {
    return command.addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Which round: Meme or Art')
        .setRequired(true)
        .addChoices({ name: 'Meme', value: 'Meme' }, { name: 'Art', value: 'Art' })
    );
  }

  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('start-vote')
        .setDescription('Start a vote in this server (type: Meme or Art).')
        .addStringOption((option) =>
          option
            .setName('type')
            .setDescription('Vote type: Meme or Art')
            .setRequired(true)
            .addChoices({ name: 'Meme', value: 'Meme' }, { name: 'Art', value: 'Art' })
        )
        .addIntegerOption((option) =>
          option
            .setName('duration')
            .setDescription('Vote duration in hours')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(168)
        )
        // Entry-based options (entry1..entry10). entry1 and entry2 are required.
        .addStringOption((option) => option.setName('entry1').setDescription('Entry link 1').setRequired(true).setMaxLength(1000))
        .addStringOption((option) => option.setName('entry2').setDescription('Entry link 2').setRequired(true).setMaxLength(1000))
        .addStringOption((option) => option.setName('entry3').setDescription('Entry link 3').setMaxLength(1000))
        .addStringOption((option) => option.setName('entry4').setDescription('Entry link 4').setMaxLength(1000))
        .addStringOption((option) => option.setName('entry5').setDescription('Entry link 5').setMaxLength(1000))
        .addStringOption((option) => option.setName('entry6').setDescription('Entry link 6').setMaxLength(1000))
        .addStringOption((option) => option.setName('entry7').setDescription('Entry link 7').setMaxLength(1000))
        .addStringOption((option) => option.setName('entry8').setDescription('Entry link 8').setMaxLength(1000))
        .addStringOption((option) => option.setName('entry9').setDescription('Entry link 9').setMaxLength(1000))
        .addStringOption((option) => option.setName('entry10').setDescription('Entry link 10').setMaxLength(1000)),
      addTypeOption(
        new SlashCommandBuilder()
          .setName('my-votes')
          .setDescription('Show your submitted votes in the active art/meme round.')
      ),
      addTypeOption(
        new SlashCommandBuilder()
          .setName('end-vote')
          .setDescription('End the active art/meme vote in this server (vote starters only).')
      ),
      addTypeOption(
        new SlashCommandBuilder()
          .setName('vote-results')
          .setDescription('Show current art/meme vote standing for this server (vote starters only).')
      ),
      addTypeOption(
        new SlashCommandBuilder()
          .setName('vote-details')
          .setDescription('Show per-user art/meme vote details for this server (vote starters only).')
      ),
      addTypeOption(
        new SlashCommandBuilder()
          .setName('remove-votes')
          .setDescription("Remove a user's votes from the active art/meme round (vote starters only).")
      ).addUserOption((option) =>
        option
          .setName('user')
          .setDescription('The user whose votes should be removed')
          .setRequired(true)
      ),
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

    if (interaction.commandName === 'remove-votes') {
      await handleRemoveVotesCommand(interaction);
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
    const voteType = normalizeVoteType(interaction.options.getString('type'));
    const displayLabel = voteType === 'art' ? 'Art' : 'Meme';

    const existing = getActiveVote(guildId, voteType);
    if (existing) {
      await interaction.reply({
        content: `A ${displayLabel} vote is already active in this server.`,
        flags: 64,
      });
      return;
    }

    const links = collectMemeLinks(interaction);
    if (links.length < 2) {
      await interaction.reply({
        content: `Provide at least 2 ${voteType} entries (entry1, entry2, ...).`,
        flags: 64,
      });
      return;
    }

    const invalidLink = links.find((link) => !isLikelyHttpUrl(link));
    if (invalidLink) {
      await interaction.reply({
        content: `Invalid ${voteType} link: ${invalidLink}`,
        flags: 64,
      });
      return;
    }

    const duration = interaction.options.getInteger('duration', true);
    const remainingMs = duration * 60 * 60 * 1000;
    const endAt = Date.now() + remainingMs;
    const endsOnEpochSeconds = Math.floor(endAt / 1000);

    const memes = links.map((link, idx) => ({
      index: idx + 1,
      link,
      messageId: null,
    }));

    const vote = {
      id: `${guildId}-${voteType}-${Date.now()}`,
      guildId,
      startChannelId: interaction.channelId,
      startedById: interaction.user.id,
      startedByUsername: interaction.user.username,
      createdAt: Date.now(),
      endAt,
      memes,
      type: voteType,
      votesByUser: new Map(),
      votersByMeme: new Map(memes.map((m) => [m.index, new Set()])),
      voteLog: [],
      closed: false,
      closedAt: null,
      timeoutHandle: null,
    };

    vote.timeoutHandle = setTimeout(async () => {
      const channel = await interaction.client.channels.fetch(vote.startChannelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        await closeVote(guildId, voteType, channel, 'Voting window finished.');
      } else {
        vote.closed = true;
        vote.closedAt = Date.now();
        activeVotes.delete(activeKey(guildId, voteType));
        markVoteClosed(vote.id, vote.closedAt);
      }
    }, remainingMs);

    activeVotes.set(activeKey(guildId, voteType), vote);
    persistVoteRow(vote);

    const pluralLabel = voteType === 'art' ? 'art entries' : 'memes';

    await interaction.reply({
      content:
        `${displayLabel} vote started by ${interaction.user}.\n` +
        `Duration: **${duration} hour(s)**\n` +
        `Ends on: <t:${endsOnEpochSeconds}:F> (<t:${endsOnEpochSeconds}:R>)\n` +
        `${displayLabel}s in this round: **${memes.length}**\n` +
        `Eligible users can vote using the buttons below. Each user can vote exactly ${REQUIRED_VOTES_PER_USER} times for different ${pluralLabel}.`,
    });

    for (const meme of memes) {
      const button = new ButtonBuilder()
        .setCustomId(buildMemeButtonCustomId(vote.id, meme.index))
        .setLabel(`Vote ${displayLabel} #${meme.index}`)
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);

      const posted = await interaction.channel.send({
        content: `**${displayLabel} #${meme.index}**\n${meme.link}\nClick the button below to vote for this ${voteType}.`,
        components: [row],
      });

      meme.messageId = posted.id;
    }

    persistVoteRow(vote);
  }

  async function handleMemeVoteButton(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This button can only be used in a server.',
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
    const vote = findActiveVoteById(guildId, parsed.voteId);
    if (!vote) {
      await interaction.reply({
        content: 'This vote button belongs to an older or already closed vote round.',
        flags: 64,
      });
      return;
    }

    if (Date.now() > vote.endAt) {
      await closeVote(guildId, vote.type, interaction.channel, 'Voting window finished.');
      await interaction.reply({
        content: 'This vote already ended.',
        flags: 64,
      });
      return;
    }

    const meme = vote.memes.find((item) => item.index === parsed.memeIndex);
    const displayLabel = vote.type === 'art' ? 'Art' : 'Meme';
    const displayWord = vote.type === 'art' ? 'art' : 'meme';
    const pluralLabel = vote.type === 'art' ? 'art entries' : 'memes';

    if (!meme) {
      await interaction.reply({
        content: `Selected ${displayWord} was not found in this vote.`,
        flags: 64,
      });
      return;
    }

    const userVotes = vote.votesByUser.get(interaction.user.id) || new Set();

    if (userVotes.has(meme.index)) {
      await interaction.reply({
        content: `You already voted for ${displayLabel} #${meme.index}. Choose a different ${displayWord}.`,
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

    const logEntry = {
      userId: interaction.user.id,
      username: interaction.user.username,
      memeIndex: meme.index,
      memeLink: meme.link,
      votedAt: Date.now(),
      source: 'button',
    };
    vote.voteLog.push(logEntry);
    appendVoteLog(vote.id, logEntry);

    const remaining = REQUIRED_VOTES_PER_USER - userVotes.size;

    await interaction.reply({
      content:
        `Vote recorded for ${displayLabel} #${meme.index}.\n` +
        `Link: ${meme.link}\n` +
        `Remaining votes: **${remaining}** (must be different ${pluralLabel}).`,
      flags: 64,
    });

    if (interaction.guildId === MEME_VOTE_AUDIT_GUILD_ID) {
      await logToAuditChannel(
        interaction.client,
        MEME_VOTE_AUDIT_CHANNEL_ID,
        `[MEME_VOTE] user=${interaction.user.tag} (${interaction.user.id}) guild=${interaction.guildId} ${displayWord}=#${meme.index} link=${meme.link}`
      );
    }
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

    const voteType = normalizeVoteType(interaction.options.getString('type'));
    const displayLabel = voteType === 'art' ? 'Art' : 'Meme';

    const resolvedVote = getCurrentOrLatestVote(interaction.guildId, voteType);
    if (!resolvedVote) {
      await interaction.reply({
        content: `No ${displayLabel} vote data found for this server.`,
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
      content: `${isActive ? `Current ${displayLabel} vote results` : `Latest closed ${displayLabel} vote results`}\n${lines.join('\n')}`,
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

    const voteType = normalizeVoteType(interaction.options.getString('type'));
    const displayLabel = voteType === 'art' ? 'Art' : 'Meme';

    const vote = getActiveVote(interaction.guildId, voteType);
    if (!vote) {
      await interaction.reply({
        content: `There is no active ${displayLabel} vote in this server.`,
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
        `Your ${displayLabel.toLowerCase()} votes:\n${selected.length ? selected.join('\n') : 'none'}\n` +
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

    const voteType = normalizeVoteType(interaction.options.getString('type'));
    const displayLabel = voteType === 'art' ? 'Art' : 'Meme';

    const resolvedVote = getCurrentOrLatestVote(interaction.guildId, voteType);
    if (!resolvedVote) {
      await interaction.reply({
        content: `No ${displayLabel} vote data found for this server.`,
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
          .map((index) => `#${index}`)
          .join(', ');

        return `- ${latestUsername} (<@${userId}>): ${votesSet.size} vote(s) [${votedMemes || 'none'}]`;
      })
      .sort((a, b) => a.localeCompare(b));

    const content =
      details.length > 0
        ? `${isActive ? `${displayLabel} vote details (per user)` : `Latest closed ${displayLabel} vote details (per user)`}\n${details.join('\n')}`
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

    const voteType = normalizeVoteType(interaction.options.getString('type'));
    const displayLabel = voteType === 'art' ? 'Art' : 'Meme';

    const vote = getActiveVote(interaction.guildId, voteType);
    if (!vote) {
      await interaction.reply({
        content: `There is no active ${displayLabel} vote in this server.`,
        flags: 64,
      });
      return;
    }

    await closeVote(
      interaction.guildId,
      voteType,
      interaction.channel,
      `${displayLabel} vote ended manually by <@${interaction.user.id}>.`
    );

    await interaction.reply({
      content: `${displayLabel} vote ended successfully.`,
      flags: 64,
    });
  }

  async function handleRemoveVotesCommand(interaction) {
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
        content: 'You are not allowed to remove votes.',
        flags: 64,
      });
      return;
    }

    const voteType = normalizeVoteType(interaction.options.getString('type'));
    const displayLabel = voteType === 'art' ? 'Art' : 'Meme';
    const displayWord = voteType === 'art' ? 'art' : 'meme';
    const targetUser = interaction.options.getUser('user', true);

    const vote = getActiveVote(interaction.guildId, voteType);
    if (!vote) {
      await interaction.reply({
        content: `There is no active ${displayLabel} vote in this server.`,
        flags: 64,
      });
      return;
    }

    const removedIndexes = [...(vote.votesByUser.get(targetUser.id) || new Set())].sort(
      (a, b) => a - b
    );

    if (removedIndexes.length === 0) {
      await interaction.reply({
        content: `${targetUser.tag} has no votes in the active ${displayLabel} round.`,
        flags: 64,
      });
      return;
    }

    // Remove from the persistent log, then drop the user from the in-memory tallies.
    deleteUserVoteLog(vote.id, targetUser.id);
    vote.votesByUser.delete(targetUser.id);
    for (const voters of vote.votersByMeme.values()) {
      voters.delete(targetUser.id);
    }
    vote.voteLog = vote.voteLog.filter((entry) => entry.userId !== targetUser.id);

    const removedList = removedIndexes.map((index) => `#${index}`).join(', ');

    await interaction.reply({
      content:
        `Removed **${removedIndexes.length}** ${displayWord} vote(s) for ${targetUser} ` +
        `from the active ${displayLabel} round (${removedList}).`,
      flags: 64,
    });

    // Log removals to the audit channel the same way individual votes are logged.
    if (interaction.guildId === MEME_VOTE_AUDIT_GUILD_ID) {
      await logToAuditChannel(
        interaction.client,
        MEME_VOTE_AUDIT_CHANNEL_ID,
        `[MEME_VOTE_REMOVE] by=${interaction.user.tag} (${interaction.user.id}) ` +
          `target=${targetUser.tag} (${targetUser.id}) guild=${interaction.guildId} ` +
          `${displayWord}=${removedList}`
      );
    }
  }

  async function closeVote(guildId, type, channel, reason) {
    const vote = getActiveVote(guildId, type);
    if (!vote) {
      return;
    }

    vote.closed = true;
    vote.closedAt = Date.now();
    activeVotes.delete(activeKey(guildId, type));

    if (vote.timeoutHandle) {
      clearTimeout(vote.timeoutHandle);
    }

    markVoteClosed(vote.id, vote.closedAt);

    const displayLabel = type === 'art' ? 'Art' : 'Meme';
    if (channel && channel.isTextBased()) {
      await channel.send(
        `${reason}\n${displayLabel} vote is now closed. Authorized users can view results privately with /vote-results type:${displayLabel}.`
      );
    }
  }

  return {
    buildCommands,
    handleInteraction,
    getActiveCount: () => activeVotes.size,
  };
}

function collectMemeLinks(interaction) {
  const links = [];
  for (let i = 1; i <= MAX_MEMES; i += 1) {
    // Prefer entryX (new) but fall back to memeX (backwards compatibility)
    const value = interaction.options.getString(`entry${i}`) || interaction.options.getString(`meme${i}`);
    if (!value) {
      continue;
    }

    const trimmed = String(value).trim();
    if (!trimmed) {
      continue;
    }

    links.push(toVxRedditUrl(trimmed));
  }

  return links;
}

function toVxRedditUrl(url) {
  const redditMatch = url.match(/^https?:\/\/(?:www\.|old\.|np\.)?reddit\.com(\/.*)$/i);
  if (redditMatch) {
    return `https://www.vxreddit.com${redditMatch[1]}`;
  }

  // If it's already a vxreddit URL without www, add www. Keep existing www.
  const vxMatch = url.match(/^https?:\/\/(?:www\.)?vxreddit\.com(\/.*)$/i);
  if (vxMatch) {
    return `https://www.vxreddit.com${vxMatch[1]}`;
  }

  return url;
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
