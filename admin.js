const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ActivityType,
} = require('discord.js');

const { setCustomStatus } = require('./status');

const ADMIN_DISCORD_IDS = ['870144657865191455', '534818361914425374', '499232799744720896'];
const ADMIN_WITHDRAWALS_BUTTON_ID = 'admin_recent_withdrawals';

const adminCommand = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Show admin wallet stats and recent withdrawals')
  .setDMPermission(true);

const userStatsCommand = new SlashCommandBuilder()
  .setName('userstats')
  .setDescription('View detailed stats for a user (admin only)')
  .setDMPermission(true)
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('User to view stats for')
      .setRequired(true)
  );

const changeStatusCommand = new SlashCommandBuilder()
  .setName('changestatus')
  .setDescription('Change bot activity type and text (admin only)')
  .setDMPermission(true)
  .addStringOption((option) =>
    option
      .setName('type')
      .setDescription('Activity type')
      .addChoices(
        { name: 'Playing', value: 'Playing' },
        { name: 'Streaming', value: 'Streaming' },
        { name: 'Listening', value: 'Listening' },
        { name: 'Watching', value: 'Watching' },
        { name: 'Competing', value: 'Competing' }
      )
      .setRequired(true)
  )
  .addStringOption((option) =>
    option.setName('name').setDescription('Activity text').setRequired(true)
  );

function formatSats(amount) {
  return `${amount} <:_sats:1501104690790662216>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function isAuthorized(interaction) {
  return interaction && interaction.user && ADMIN_DISCORD_IDS.includes(interaction.user.id);
}

function denyEmbed() {
  return new EmbedBuilder()
    .setTitle('Admin Access Denied')
    .setDescription('You are not authorized to use this command.')
    .setColor(0xe74c3c);
}

function isInteractionGoneError(error) {
  const code = error && error.code ? Number(error.code) : 0;
  return code === 10062 || code === 40060 || code === 10015;
}

async function handleAdminCommand(interaction, query, coinosRequest) {
  if (!isAuthorized(interaction)) {
    try {
      await interaction.reply({ embeds: [denyEmbed()], flags: MessageFlags.Ephemeral });
    } catch (error) {
      if (!isInteractionGoneError(error)) {
        throw error;
      }
    }
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (isInteractionGoneError(error)) {
      return;
    }
    throw error;
  }

  const totalsResult = await query(
    "select " +
      "coalesce((select sum(balance_sats) from users), 0) as total_balance_sats, " +
      "coalesce((select sum(delta_sats) from balance_ledger where reason like 'deposit:%' and delta_sats > 0), 0) as total_deposits_sats, " +
      "coalesce((select sum(-delta_sats) from balance_ledger where (reason = 'withdraw' or reason = 'pay') and delta_sats < 0), 0) - " +
      "coalesce((select sum(delta_sats) from balance_ledger where (reason = 'withdraw:reversal' or reason = 'pay:reversal') and delta_sats > 0), 0) as total_withdrawals_sats"
  );

  const totals = totalsResult.rows[0] || {};
  const totalBalance = Number(totals.total_balance_sats || 0);
  const totalDeposits = Number(totals.total_deposits_sats || 0);
  const totalWithdrawals = Math.max(0, Number(totals.total_withdrawals_sats || 0));

  let coinosBalance = 0;
  try {
    const accountData = await coinosRequest('/me', 'GET');
    coinosBalance = Number(accountData && accountData.balance ? accountData.balance : 0);
  } catch (error) {
    console.error('Failed to fetch Coinos balance:', error.message);
  }

  const embed = new EmbedBuilder()
    .setTitle('Admin Dashboard')
    .setColor(0x1abc9c)
    .addFields(
      { name: 'Total User Balance', value: formatSats(formatNumber(totalBalance)), inline: false },
      { name: 'Coinos Wallet Balance', value: formatSats(formatNumber(coinosBalance)), inline: false },
      { name: 'Total Deposits', value: formatSats(formatNumber(totalDeposits)), inline: true },
      { name: 'Total Withdrawals', value: formatSats(formatNumber(totalWithdrawals)), inline: true }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ADMIN_WITHDRAWALS_BUTTON_ID)
      .setLabel('Recent 20 Withdrawals')
      .setStyle(ButtonStyle.Secondary)
  );

  try {
    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (error) {
    if (!isInteractionGoneError(error)) {
      throw error;
    }
  }
}

async function handleAdminWithdrawalsButton(interaction, query) {
  if (interaction.customId !== ADMIN_WITHDRAWALS_BUTTON_ID) {
    return false;
  }

  if (!isAuthorized(interaction)) {
    try {
      await interaction.reply({ embeds: [denyEmbed()], flags: MessageFlags.Ephemeral });
    } catch (error) {
      if (!isInteractionGoneError(error)) {
        throw error;
      }
    }
    return true;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (isInteractionGoneError(error)) {
      return true;
    }
    throw error;
  }

  const withdrawals = await query(
    "select u.discord_username, b.discord_id, -b.delta_sats as amount_sats, b.created_at, b.reason, " +
      "CASE WHEN EXISTS ( " +
        "select 1 from balance_ledger b2 " +
        "where b2.discord_id = b.discord_id " +
        "and (b2.reason = 'withdraw:reversal' or b2.reason = 'pay:reversal') " +
        "and b2.delta_sats = -b.delta_sats " +
        "and b2.created_at > b.created_at " +
        "limit 1 " +
      ") THEN true ELSE false END as was_reversed " +
      "from balance_ledger b " +
      "left join users u on u.discord_id = b.discord_id " +
      "where (b.reason = 'withdraw' or b.reason = 'pay') and b.delta_sats < 0 " +
      "order by b.created_at desc limit 20"
  );

  if (withdrawals.rows.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle('Recent Withdrawals')
      .setDescription('No withdrawals found.')
      .setColor(0x95a5a6);
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      if (!isInteractionGoneError(error)) {
        throw error;
      }
    }
    return true;
  }

  const lines = withdrawals.rows.map((row) => {
    const username = row.discord_username || 'unknown-user';
    const mention = `<@${row.discord_id}>`;
    const amount = Number(row.amount_sats || 0);
    const timestamp = Math.floor(new Date(row.created_at).getTime() / 1000);
    const type = row.reason === 'pay' ? 'Payment' : 'Withdrawal';
    const status = row.was_reversed ? ' (Failed)' : '';
    return `• ${username} ${mention} - ${formatSats(formatNumber(amount))} (${type}${status}) <t:${timestamp}:R>`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Recent 20 Withdrawals')
    .setDescription(lines.join('\n').slice(0, 3900))
    .setColor(0xf39c12);

  try {
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    if (!isInteractionGoneError(error)) {
      throw error;
    }
  }
  return true;
}

function formatReason(reason) {
  if (!reason) return 'Activity';

  if (reason.startsWith('deposit:')) {
    return 'Deposit ⚡';
  }

  if (reason.startsWith('tip:out:')) {
    return 'Tip sent <a:peperain:1501114711272460358>';
  }

  if (reason.startsWith('tip:from:')) {
    return 'Tip received <a:peperain:1501114711272460358>';
  }

  if (reason.startsWith('rain:out:')) {
    return 'Rain sent <a:rain:1501110375154978916>';
  }

  if (reason.startsWith('rain:from:')) {
    return 'Rain received <a:rain:1501110375154978916>';
  }

  if (reason === 'withdraw') {
    return 'Withdrawal <a:purpleflame:1501111816334479441>';
  }

  if (reason === 'withdraw:reversal') {
    return 'Withdrawal reversed <a:purpleflame:1501111816334479441>';
  }

  if (reason === 'pay') {
    return 'Payment sent <a:purpleflame:1501111816334479441>';
  }

  if (reason === 'pay:reversal') {
    return 'Payment reversed <a:purpleflame:1501111816334479441>';
  }

  return reason.slice(0, 64);
}

async function handleUserStatsCommand(interaction, query) {
  if (!isAuthorized(interaction)) {
    try {
      await interaction.reply({ embeds: [denyEmbed()], flags: MessageFlags.Ephemeral });
    } catch (error) {
      if (!isInteractionGoneError(error)) {
        throw error;
      }
    }
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const targetId = targetUser.id;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (isInteractionGoneError(error)) {
      return;
    }
    throw error;
  }

  try {
    const userResult = await query(
      'select discord_username, balance_sats, lightning_address from users where discord_id = $1',
      [targetId]
    );

    if (userResult.rows.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('User Not Found')
        .setDescription(`No data found for <@${targetId}>.`)
        .setColor(0x95a5a6);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const user = userResult.rows[0];
    const username = user.discord_username || 'unknown-user';
    const balance = Number(user.balance_sats || 0);
    const linkedAddress = user.lightning_address || 'None';

    const totalsResult = await query(
      "select " +
        "coalesce((select sum(delta_sats) from balance_ledger where discord_id = $1 and reason like 'deposit:%' and delta_sats > 0), 0) as total_deposits_sats, " +
        "coalesce((select sum(-delta_sats) from balance_ledger where discord_id = $1 and (reason = 'withdraw' or reason = 'pay') and delta_sats < 0), 0) - " +
        "coalesce((select sum(delta_sats) from balance_ledger where discord_id = $1 and (reason = 'withdraw:reversal' or reason = 'pay:reversal') and delta_sats > 0), 0) as total_withdrawals_sats, " +
        "coalesce((select sum(-delta_sats) from balance_ledger where discord_id = $1 and reason like 'tip:out:%' and delta_sats < 0), 0) as total_tipped_sats, " +
        "coalesce((select sum(-delta_sats) from balance_ledger where discord_id = $1 and reason like 'rain:out:%' and delta_sats < 0), 0) as total_rained_sats",
      [targetId]
    );

    const totals = totalsResult.rows[0] || {};
    const totalDeposits = Number(totals.total_deposits_sats || 0);
    const totalWithdrawals = Math.max(0, Number(totals.total_withdrawals_sats || 0));
    const totalTipped = Number(totals.total_tipped_sats || 0);
    const totalRained = Number(totals.total_rained_sats || 0);

    const historyResult = await query(
      'select delta_sats, reason, created_at from balance_ledger where discord_id = $1 order by created_at desc limit 5',
      [targetId]
    );

    const embed = new EmbedBuilder()
      .setTitle(`User Stats - ${username}`)
      .setDescription(`<@${targetId}>`)
      .setColor(0x3498db)
      .addFields(
        { name: 'Current Balance', value: formatSats(formatNumber(balance)), inline: true },
        { name: 'Total Deposits', value: formatSats(formatNumber(totalDeposits)), inline: true },
        { name: 'Total Withdrawals', value: formatSats(formatNumber(totalWithdrawals)), inline: true },
        { name: 'Total Tipped', value: formatSats(formatNumber(totalTipped)), inline: true },
        { name: 'Total Rained', value: formatSats(formatNumber(totalRained)), inline: true },
        { name: 'Linked Address', value: linkedAddress, inline: false }
      );

    if (historyResult.rows.length > 0) {
      const lines = historyResult.rows.map((entry) => {
        const delta = Number(entry.delta_sats);
        const signed = delta > 0 ? `+${delta}` : `${delta}`;
        const when = Math.floor(new Date(entry.created_at).getTime() / 1000);
        const direction = delta >= 0 ? '<:in:1501119632352870481>' : '<:out:1501119649339936813>';
        return `• ${direction} ${signed} <:_sats:1501104690790662216> — ${formatReason(entry.reason)} <t:${when}:R>`;
      });
      embed.addFields({
        name: 'Last 5 Transactions',
        value: lines.join('\n').slice(0, 1024),
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Failed to fetch user stats:', error.message);
    const embed = new EmbedBuilder()
      .setTitle('Error')
      .setDescription('Failed to fetch user stats.')
      .setColor(0xe74c3c);
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (responseError) {
      if (!isInteractionGoneError(responseError)) {
        throw responseError;
      }
    }
  }
}

async function handleChangeStatusCommand(interaction, query) {
  if (!isAuthorized(interaction)) {
    try {
      await interaction.reply({ embeds: [denyEmbed()], flags: MessageFlags.Ephemeral });
    } catch (error) {
      if (!isInteractionGoneError(error)) {
        throw error;
      }
    }
    return;
  }

  const typeName = interaction.options.getString('type', true);
  const name = interaction.options.getString('name', true);

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (isInteractionGoneError(error)) return;
    throw error;
  }

  try {
    setCustomStatus(interaction.client, typeName, name);
    const embed = new EmbedBuilder()
      .setTitle('Status Updated')
      .setDescription(`Activity set to **${typeName}**: ${name}`)
      .setColor(0x2ecc71);
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Failed to change status:', error.message);
    const embed = new EmbedBuilder()
      .setTitle('Change Status Failed')
      .setDescription(truncateText(error.message, 200))
      .setColor(0xe74c3c);
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (responseError) {
      if (!isInteractionGoneError(responseError)) throw responseError;
    }
  }
}

module.exports = {
  ADMIN_DISCORD_IDS,
  adminCommand,
  userStatsCommand,
  changeStatusCommand,
  handleChangeStatusCommand,
  handleAdminCommand,
  handleAdminWithdrawalsButton,
  handleUserStatsCommand,
};
