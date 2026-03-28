const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const rankPoints = [100, 60, 40];

function createQuizModule({ quizMasterIds, timeoutSeconds }) {
  const activeQuizByChannel = new Map();
  const quizHistoryByChannel = new Map();
  const scoreBoard = new Map();

  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('question')
        .setDescription('Start a quiz question in this channel.')
        .addStringOption((option) =>
          option.setName('name').setDescription('Question text or GIF URL').setRequired(true)
        )
        .addStringOption((option) =>
          option.setName('answer').setDescription('Expected answer').setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName('scoreboard')
        .setDescription('Show quiz scoreboard for this server.'),
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset quiz scoreboard for this server.'),
    ];
  }

  async function handleInteraction(interaction) {
    if (interaction.commandName === 'question') {
      await handleQuestionCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'scoreboard') {
      await handleScoreboardCommand(interaction);
      return true;
    }

    if (interaction.commandName === 'reset') {
      await handleResetCommand(interaction);
      return true;
    }

    return false;
  }

  async function handleMessage(message) {
    if (message.author.bot) {
      return;
    }

    await trySubmitAnswer({
      channelId: message.channelId,
      channel: message.channel,
      user: message.author,
      rawAnswer: message.content,
      onSuccess: async () => {},
    });
  }

  async function handleQuestionCommand(interaction) {
    if (!quizMasterIds.has(interaction.user.id)) {
      await interaction.reply({
        content: 'You are not allowed to start quiz questions.',
        flags: 64,
      });
      return;
    }

    const currentQuiz = activeQuizByChannel.get(interaction.channelId);
    if (currentQuiz && !currentQuiz.closed) {
      await interaction.reply({
        content: 'There is already an active quiz question in this channel.',
        flags: 64,
      });
      return;
    }

    const questionName = interaction.options.getString('name', true).trim();
    const answer = interaction.options.getString('answer', true);

    const quiz = {
      id: `${interaction.channelId}:${Date.now()}`,
      channelId: interaction.channelId,
      questionName,
      answerText: answer,
      answerNormalized: normalizeAnswer(answer),
      askedById: interaction.user.id,
      askedByUsername: interaction.user.username,
      createdAt: Date.now(),
      winners: [],
      closed: false,
      timeoutHandle: null,
    };

    quiz.timeoutHandle = setTimeout(async () => {
      const channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        await closeQuiz(interaction.channelId, channel, 'Quiz closed due to timeout.');
      } else {
        quiz.closed = true;
        activeQuizByChannel.delete(interaction.channelId);
        saveQuizHistory(interaction.channelId, quiz);
      }
    }, timeoutSeconds * 1000);

    activeQuizByChannel.set(interaction.channelId, quiz);

    await interaction.channel.send(buildQuestionMessage({
      askedBy: `${interaction.user}`,
      questionName,
      instruction:
        'Type your answer in channel. First correct user gets 100 points, second 60, third 40.',
    }));

    await interaction.reply({
      content: 'Quiz posted in this channel.',
      flags: 64,
    });
  }

  async function trySubmitAnswer({ channelId, channel, user, rawAnswer, onSuccess }) {
    const quiz = activeQuizByChannel.get(channelId);
    if (!quiz || quiz.closed) {
      return 'no-quiz';
    }

    if (quiz.winners.length >= rankPoints.length) {
      return 'quiz-full';
    }

    if (quiz.winners.some((winner) => winner.userId === user.id)) {
      return 'already-won';
    }

    if (normalizeAnswer(rawAnswer) !== quiz.answerNormalized) {
      return 'incorrect';
    }

    const rankIndex = quiz.winners.length;
    const points = rankPoints[rankIndex];

    const winner = {
      userId: user.id,
      username: user.username,
      rank: rankIndex + 1,
      points,
      answeredAt: Date.now(),
    };

    quiz.winners.push(winner);

    const currentScore = scoreBoard.get(user.id) || {
      userId: user.id,
      username: user.username,
      points: 0,
    };

    currentScore.username = user.username;
    currentScore.points += points;
    scoreBoard.set(user.id, currentScore);

    await onSuccess(winner);

    if (quiz.winners.length >= rankPoints.length) {
      await closeQuiz(channelId, channel, 'Quiz complete: top 3 winners found.');
    }

    return 'correct';
  }

  async function handleScoreboardCommand(interaction) {
    if (!quizMasterIds.has(interaction.user.id)) {
      await interaction.reply({
        content: 'You are not allowed to view the quiz scoreboard.',
        flags: 64,
      });
      return;
    }

    const sorted = [...scoreBoard.values()].sort((a, b) => b.points - a.points);

    if (sorted.length === 0) {
      await interaction.reply('No quiz points recorded yet.');
      return;
    }

    const lines = sorted
      .slice(0, 50)
      .map((entry, idx) => `${idx + 1}. ${entry.username} - ${entry.points} pts`);

    await interaction.reply(`Quiz Scoreboard\n${lines.join('\n')}`);
  }

  async function handleResetCommand(interaction) {
    if (!quizMasterIds.has(interaction.user.id)) {
      await interaction.reply({
        content: 'Only quiz masters can reset the quiz scoreboard.',
        flags: 64,
      });
      return;
    }

    scoreBoard.clear();

    await interaction.reply({
      content: 'Quiz scoreboard has been reset.',
      flags: 64,
    });
  }

  async function closeQuiz(channelId, channel, reason) {
    const quiz = activeQuizByChannel.get(channelId);
    if (!quiz || quiz.closed) {
      return;
    }

    quiz.closed = true;
    activeQuizByChannel.delete(channelId);

    if (quiz.timeoutHandle) {
      clearTimeout(quiz.timeoutHandle);
    }

    saveQuizHistory(channelId, quiz);

    const winnersSummary = quiz.winners.length
      ? quiz.winners
          .map((w) => `#${w.rank} ${w.username} (<@${w.userId}>) (+${w.points})`)
          .join('\n')
      : 'No correct answers.';

    await channel.send(
      buildQuestionMessage({
        prefix: reason,
        questionName: quiz.questionName,
        suffix: `Right answer: **${escapeMarkdown(quiz.answerText)}**\nWinners:\n${winnersSummary}`,
      })
    );
  }

  function saveQuizHistory(channelId, quiz) {
    const history = quizHistoryByChannel.get(channelId) || [];

    history.push({
      id: quiz.id,
      channelId: quiz.channelId,
      questionName: quiz.questionName,
      askedById: quiz.askedById,
      askedByUsername: quiz.askedByUsername,
      createdAt: quiz.createdAt,
      closedAt: Date.now(),
      winners: [...quiz.winners],
    });

    quizHistoryByChannel.set(channelId, history);
  }

  return {
    buildCommands,
    handleInteraction,
    handleMessage,
    getActiveCount: () => activeQuizByChannel.size,
  };
}

function normalizeAnswer(input) {
  return input.trim().toLowerCase();
}

function escapeMarkdown(value) {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function formatQuestionLine(questionName) {
  if (isGifUrl(questionName)) {
    return 'Question (GIF):';
  }

  return `Question: **${escapeMarkdown(questionName)}**`;
}

function isGifUrl(value) {
  if (!/^https?:\/\/\S+$/i.test(value)) {
    return false;
  }

  return /\.gif(\?.*)?$/i.test(value) || /(tenor\.com|giphy\.com)/i.test(value);
}

function buildQuestionMessage({ askedBy, prefix, questionName, instruction, suffix }) {
  const lines = [];

  if (prefix) {
    lines.push(prefix);
  }

  if (askedBy) {
    lines.push(`Quiz started by ${askedBy}.`);
  }

  lines.push(formatQuestionLine(questionName));

  if (instruction) {
    lines.push(instruction);
  }

  if (suffix) {
    lines.push(suffix);
  }

  if (!isGifUrl(questionName)) {
    return lines.join('\n');
  }

  const embed = new EmbedBuilder().setImage(questionName);
  return {
    content: lines.join('\n'),
    embeds: [embed],
  };
}

module.exports = {
  createQuizModule,
};
