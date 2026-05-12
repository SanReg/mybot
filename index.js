const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const dotenv = require('dotenv');
const QRCode = require('qrcode');
const crypto = require('crypto');
const bolt11 = require('bolt11');
const { setBotStatus } = require('./status');
const { adminCommand, userStatsCommand, changeStatusCommand, handleAdminCommand, handleAdminWithdrawalsButton, handleUserStatsCommand, handleChangeStatusCommand } = require('./admin');

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const COINOS_TOKEN = process.env.COINOS_TOKEN;
const COINOS_PIN = process.env.COINOS_PIN;
const DATABASE_URL = process.env.DATABASE_URL;
const COINOS_API = 'https://coinos.io/api';
const TARGET_GUILD_ID = '931174322989580308';

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !COINOS_TOKEN || !COINOS_PIN || !DATABASE_URL) {
  console.error(
    'Missing required env vars. Set DISCORD_TOKEN, DISCORD_CLIENT_ID, COINOS_TOKEN, COINOS_PIN, DATABASE_URL.'
  );
  process.exit(1);
}

const { pool, query } = require('./db');
const invoiceCache = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Create a Lightning invoice to deposit funds')
    .setDMPermission(true)
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Amount in satoshis')
        .setRequired(true)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Withdraw sats to your linked Lightning address')
    .setDMPermission(true)
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Amount in satoshis')
        .setRequired(true)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show your current balance')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('tip')
    .setDescription('Send sats to a user from your balance')
    .setDMPermission(true)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to tip')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Amount in satoshis')
        .setRequired(true)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName('rain')
    .setDescription('Send sats to recent users in this channel')
    .setDMPermission(false)
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Amount per user in satoshis')
        .setRequired(true)
        .setMinValue(1)
    )
    .addIntegerOption((option) =>
      option
        .setName('maxcount')
        .setDescription('Maximum number of recipients')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50)
    ),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show your recent balance activity')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show top rain senders')
    .setDMPermission(true)
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Leaderboard type')
        .addChoices(
          { name: 'makers', value: 'makers' },
          { name: 'catchers', value: 'catchers' }
        )
    ),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Lightning address')
    .setDMPermission(true)
    .addStringOption((option) =>
      option
        .setName('address')
        .setDescription('Lightning address (name@domain)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Pay a Lightning invoice from your balance')
    .setDMPermission(true)
    .addStringOption((option) =>
      option
        .setName('payreq')
        .setDescription('Lightning invoice (BOLT11)')
        .setRequired(true)
    ),
  adminCommand,
  userStatsCommand,
  changeStatusCommand,
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log('Registered global slash commands.');

  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, TARGET_GUILD_ID), { body: commands });
  console.log(`Registered guild slash commands for ${TARGET_GUILD_ID}.`);
}

async function coinosRequest(path, method, body) {
  const response = await fetch(`${COINOS_API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${COINOS_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data && data.error ? data.error : response.statusText;
    throw new Error(message);
  }

  return data;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data && data.reason ? data.reason : response.statusText;
    throw new Error(message);
  }
  return data;
}

async function getLnurlPayInvoice(address, amountSats) {
  const parts = address.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid lightning address.');
  }

  const [name, domain] = parts;
  const lnurlUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  const lnurlData = await fetchJson(lnurlUrl);

  if (lnurlData.tag !== 'payRequest' || !lnurlData.callback) {
    throw new Error('Lightning address does not support payments.');
  }

  const amountMsats = amountSats * 1000;
  const minSendable = Number(lnurlData.minSendable || 0);
  const maxSendable = Number(lnurlData.maxSendable || 0);

  if (amountMsats < minSendable || (maxSendable > 0 && amountMsats > maxSendable)) {
    throw new Error('Amount is outside the lightning address limits.');
  }

  const callbackUrl = new URL(lnurlData.callback);
  callbackUrl.searchParams.set('amount', String(amountMsats));
  const invoiceData = await fetchJson(callbackUrl.toString());

  const payreq = invoiceData.pr || invoiceData.payRequest;
  if (!payreq) {
    throw new Error('Failed to get invoice from lightning address.');
  }

  return payreq;
}

async function validateLightningAddress(address) {
  const parts = address.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid lightning address.');
  }

  const [name, domain] = parts;
  const lnurlUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  const lnurlData = await fetchJson(lnurlUrl);

  if (lnurlData.tag !== 'payRequest' || !lnurlData.callback) {
    throw new Error('Lightning address does not support payments.');
  }
}

async function ensureUser(discordId, discordUsername) {
  await query(
    'insert into users (discord_id, discord_username) values ($1, $2) on conflict (discord_id) do update set discord_username = excluded.discord_username',
    [discordId, discordUsername]
  );
}

async function recordInvoice(discordId, amountSats, hash, invoiceText) {
  await query(
    'insert into lightning_invoices (discord_id, amount_sats, hash, invoice_text) values ($1, $2, $3, $4) on conflict (hash) do nothing',
    [discordId, amountSats, hash, invoiceText]
  );
}

async function syncPaidInvoices(discordId) {
  const pending = await query(
    'select id, hash, amount_sats from lightning_invoices where discord_id = $1 and paid_at is null',
    [discordId]
  );

  const credited = [];

  for (const invoice of pending.rows) {
    let invoiceData;
    try {
      invoiceData = await coinosRequest(`/invoice/${invoice.hash}`, 'GET');
    } catch (error) {
      console.error('Failed to check invoice status:', error.message);
      continue;
    }

    const received = Number(invoiceData && invoiceData.received ? invoiceData.received : 0);
    if (received < invoice.amount_sats) continue;

    const client = await pool.connect();
    try {
      await client.query('begin');
      const updateResult = await client.query(
        'update lightning_invoices set paid_at = now(), received_sats = $1 where id = $2 and paid_at is null returning amount_sats, hash',
        [received, invoice.id]
      );

      if (updateResult.rowCount === 0) {
        await client.query('rollback');
        continue;
      }

      const creditedInvoice = updateResult.rows[0];
      await client.query(
        'update users set balance_sats = balance_sats + $1 where discord_id = $2',
        [creditedInvoice.amount_sats, discordId]
      );
      await client.query(
        'insert into balance_ledger (discord_id, delta_sats, reason) values ($1, $2, $3)',
        [discordId, creditedInvoice.amount_sats, `deposit:${creditedInvoice.hash}`]
      );
      await client.query('commit');
      credited.push({ amount: creditedInvoice.amount_sats, hash: creditedInvoice.hash });
    } catch (error) {
      await client.query('rollback');
      console.error('Failed to apply deposit:', error.message);
    } finally {
      client.release();
    }
  }

  return credited;
}

async function upsertUserTx(clientDb, discordId, discordUsername) {
  await clientDb.query(
    'insert into users (discord_id, discord_username) values ($1, $2) on conflict (discord_id) do update set discord_username = excluded.discord_username',
    [discordId, discordUsername]
  );
}

async function applyTransfer({ sender, recipients, amountPer, reason }) {
  if (recipients.length === 0) {
    throw new Error('No recipients available.');
  }

  const total = amountPer * recipients.length;
  const clientDb = await pool.connect();

  try {
    await clientDb.query('begin');
    await upsertUserTx(clientDb, sender.id, sender.username);

    for (const recipient of recipients) {
      await upsertUserTx(clientDb, recipient.id, recipient.username);
    }

    const balanceResult = await clientDb.query(
      'select balance_sats from users where discord_id = $1 for update',
      [sender.id]
    );
    const balance = balanceResult.rows[0] ? balanceResult.rows[0].balance_sats : 0;

    if (balance < total) {
      throw new Error('Insufficient balance.');
    }

    await clientDb.query('update users set balance_sats = balance_sats - $1 where discord_id = $2', [
      total,
      sender.id,
    ]);
    await clientDb.query(
      'insert into balance_ledger (discord_id, delta_sats, reason) values ($1, $2, $3)',
      [sender.id, -total, `${reason}:out:${recipients.length}`]
    );

    for (const recipient of recipients) {
      await clientDb.query('update users set balance_sats = balance_sats + $1 where discord_id = $2', [
        amountPer,
        recipient.id,
      ]);
      await clientDb.query(
        'insert into balance_ledger (discord_id, delta_sats, reason) values ($1, $2, $3)',
        [recipient.id, amountPer, `${reason}:from:${sender.id}`]
      );
    }

    await clientDb.query('commit');
    return total;
  } catch (error) {
    await clientDb.query('rollback');
    throw error;
  } finally {
    clientDb.release();
  }
}

async function reserveWithdrawBalance(discordId, discordUsername, amountSats, reason = 'withdraw') {
  const clientDb = await pool.connect();

  try {
    await clientDb.query('begin');
    await upsertUserTx(clientDb, discordId, discordUsername);

    const balanceResult = await clientDb.query(
      'select balance_sats from users where discord_id = $1 for update',
      [discordId]
    );
    const balance = balanceResult.rows[0] ? balanceResult.rows[0].balance_sats : 0;

    if (balance < amountSats) {
      throw new Error('Insufficient balance.');
    }

    await clientDb.query('update users set balance_sats = balance_sats - $1 where discord_id = $2', [
      amountSats,
      discordId,
    ]);
    await clientDb.query(
      'insert into balance_ledger (discord_id, delta_sats, reason) values ($1, $2, $3)',
      [discordId, -amountSats, reason]
    );

    await clientDb.query('commit');
  } catch (error) {
    await clientDb.query('rollback');
    throw error;
  } finally {
    clientDb.release();
  }
}

async function refundWithdrawBalance(discordId, amountSats, reason = 'withdraw') {
  try {
    await query('update users set balance_sats = balance_sats + $1 where discord_id = $2', [
      amountSats,
      discordId,
    ]);
    await query('insert into balance_ledger (discord_id, delta_sats, reason) values ($1, $2, $3)', [
      discordId,
      amountSats,
      `${reason}:reversal`,
    ]);
  } catch (error) {
    console.error('Failed to refund withdrawal:', error.message);
  }
}

async function getRecentRecipients(channel, excludeId, count) {
  const recipients = [];
  const seen = new Set();
  let lastId;
  let fetched = 0;

  while (fetched < 1000 && recipients.length < count) {
    const batch = await channel.messages.fetch({ limit: 100, before: lastId });
    if (batch.size === 0) break;
    fetched += batch.size;
    lastId = batch.last().id;

    for (const message of batch.values()) {
      if (!message.author || message.author.bot) continue;
      if (message.author.id === excludeId) continue;
      if (seen.has(message.author.id)) continue;

      seen.add(message.author.id);
      recipients.push({ id: message.author.id, username: message.author.username });

      if (recipients.length >= count) break;
    }
  }

  return recipients;
}

function truncateText(value, maxLength) {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function safeDeferReply(interaction, options) {
  try {
    const deferOptions = options ? { ...options } : {};
    if (Object.prototype.hasOwnProperty.call(deferOptions, 'ephemeral')) {
      deferOptions.flags = deferOptions.ephemeral ? MessageFlags.Ephemeral : undefined;
      delete deferOptions.ephemeral;
    }

    await interaction.deferReply(deferOptions);
    return true;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('deferReply failed:', message);
    return false;
  }
}

async function safeEditReply(interaction, payload) {
  try {
    if (interaction && typeof interaction.editReply === 'function') {
      await interaction.editReply(payload);
      return true;
    }

    if (interaction && typeof interaction.reply === 'function') {
      await interaction.reply(payload);
      return true;
    }

    console.error('editReply failed: no reply method available');
    return false;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('editReply failed:', message);
    return false;
  }
}

function buildEmbed({ title, description, color, fields }) {
  const embed = new EmbedBuilder().setTitle(title).setColor(color);
  if (description) embed.setDescription(description);
  if (fields && fields.length > 0) embed.addFields(fields);
  return embed;
}

function formatSats(amount) {
  return `${amount} <:_sats:1501104690790662216>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
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

  return truncateText(reason, 64);
}

async function sendDm(user, content) {
  try {
    await user.send(content);
  } catch (error) {
    console.error('DM failed:', error.message);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  setBotStatus(client);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const customId = interaction.customId || '';

    if (customId.startsWith('copy_invoice:')) {
      const token = customId.replace('copy_invoice:', '');
      const cached = invoiceCache.get(token);
      if (!cached || cached.userId !== interaction.user.id) {
        await interaction.reply({
          content: 'Invoice expired. Please create a new deposit.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({ content: cached.invoiceText, flags: MessageFlags.Ephemeral });
      return;
    }

    let handled = false;
    try {
      handled = await handleAdminWithdrawalsButton(interaction, query);
    } catch (error) {
      console.error('Admin button failed:', error.message);
      if (interaction.deferred || interaction.replied) {
        await safeEditReply(interaction, {
          content: 'Failed to load recent withdrawals.',
          components: [],
        });
      } else {
        await interaction.reply({
          content: 'Failed to load recent withdrawals.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (handled) return;

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  console.log(`Command: ${interaction.commandName} from ${interaction.user.tag}`);

  if (interaction.commandName === 'deposit') {
    const amount = interaction.options.getInteger('amount', true);

    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;

    try {
      const data = await coinosRequest('/invoice', 'POST', {
        invoice: {
          amount,
          type: 'lightning',
        },
      });

      console.log('Deposit response:', data);

      const invoiceText = data && data.text ? data.text : 'Invoice created.';

      if (data && data.hash) {
        await ensureUser(interaction.user.id, interaction.user.username);
        await recordInvoice(interaction.user.id, amount, data.hash, data.text || null);
      }

      let row;
      if (invoiceText) {
        const token = crypto.randomUUID();
        invoiceCache.set(token, { invoiceText, userId: interaction.user.id });
        setTimeout(() => invoiceCache.delete(token), 10 * 60 * 1000);

        row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`copy_invoice:${token}`)
            .setLabel('Copy Invoice')
            .setStyle(ButtonStyle.Primary)
        );
      }

      const invoiceField = {
        name: 'Invoice ⚡',
        value: `

\`${truncateText(invoiceText, 1000)}\``.trim(),
        inline: false,
      };

      const fields = [
        { name: 'Amount', value: formatSats(amount), inline: true },
        invoiceField,
      ];

      const embed = buildEmbed({
        title: 'Deposit Created ✅',
        description: 'Pay the invoice to credit your balance.',
        color: 0x2ecc71,
        fields,
      });

      if (invoiceText) {
        const qrBuffer = await QRCode.toBuffer(invoiceText, { width: 512, margin: 1 });
        const attachment = new AttachmentBuilder(qrBuffer, { name: 'invoice.png' });
        embed.setImage('attachment://invoice.png');
        await safeEditReply(interaction, { embeds: [embed], files: [attachment], components: row ? [row] : [] });
      } else {
        await safeEditReply(interaction, { embeds: [embed], components: row ? [row] : [] });
      }
    } catch (error) {
      const embed = buildEmbed({
        title: 'Deposit Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'withdraw') {
    const amountSats = interaction.options.getInteger('amount', true);
    let reserved = false;

    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;

    try {
      await ensureUser(interaction.user.id, interaction.user.username);
      await syncPaidInvoices(interaction.user.id);

      const addressResult = await query('select lightning_address from users where discord_id = $1', [
        interaction.user.id,
      ]);
      const lightningAddress = addressResult.rows[0]
        ? addressResult.rows[0].lightning_address
        : null;

      if (!lightningAddress) {
        const embed = buildEmbed({
          title: 'Withdrawal Failed ⚠️',
          description: 'No linked lightning address. Use /link address first.',
          color: 0xe74c3c,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      const payreq = await getLnurlPayInvoice(lightningAddress, amountSats);

      try {
        await reserveWithdrawBalance(interaction.user.id, interaction.user.username, amountSats, 'withdraw');
        reserved = true;
      } catch (error) {
        const message =
          error && error.message === 'Insufficient balance.'
            ? `Insufficient balance. Needed ${formatSats(amountSats)}.`
            : truncateText(error.message || 'Unable to reserve balance.', 200);
        const embed = buildEmbed({
          title: 'Withdrawal Failed ⚠️',
          description: message,
          color: 0xe74c3c,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      const data = await coinosRequest('/payments', 'POST', {
        payreq,
        pin: COINOS_PIN,
      });

      console.log('Withdraw response:', data);

      const fields = [];
      if (data && data.amount) fields.push({ name: 'Amount', value: formatSats(data.amount), inline: true });
      if (data && data.hash) fields.push({ name: 'Hash', value: truncateText(data.hash, 64), inline: true });

      const embed = buildEmbed({
        title: 'Withdrawal Sent ✅',
        description: `Payment sent to ${lightningAddress}.`,
        color: 0x2ecc71,
        fields,
      });

      await safeEditReply(interaction, { embeds: [embed] });

      if (data && data.amount) {
        const amount = Math.abs(Number(data.amount));
        await sendDm(
          interaction.user,
          `<a:purpleflame:1501111816334479441> Your withdrawal of ${formatSats(amount)} was successful!`
        );
      }
    } catch (error) {
      if (reserved && typeof amountSats === 'number' && amountSats > 0) {
        await refundWithdrawBalance(interaction.user.id, amountSats, 'withdraw');
      }
      const embed = buildEmbed({
        title: 'Withdrawal Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'balance') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;

    try {
      await ensureUser(interaction.user.id, interaction.user.username);
      const credited = await syncPaidInvoices(interaction.user.id);
      for (const entry of credited) {
        await sendDm(
          interaction.user,
          `<a:purpleflame:1501111816334479441> Deposit received: ${formatSats(entry.amount)}`
        );
      }
      const balanceResult = await query(
        'select balance_sats, lightning_address from users where discord_id = $1',
        [interaction.user.id]
      );
      console.log('Balance query result:', balanceResult.rows);
      const balanceRow = balanceResult.rows[0];
      const balance = balanceRow ? balanceRow.balance_sats : 0;
      const linkedAddress = balanceRow ? balanceRow.lightning_address : null;

      const descriptionLines = [
        `Balance:\n${formatNumber(balance)} <:_sats:1501104690790662216>`,
      ];
      if (linkedAddress) {
        descriptionLines.push(`\n<a:pepecute:1501156277823471686> Linked Address:\n*${linkedAddress}*`);
      }

      const embed = buildEmbed({
        title: '<:wallet:1501131578313670677>  |  Wallet',
        description: descriptionLines.join('\n'),
        color: 0x3498db,
      });
      embed.setFooter({ text: '*Use /history to see recent transactions*' });
      await safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
      const embed = buildEmbed({
        title: 'Balance Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'tip') {
    const recipientUser = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    if (!(await safeDeferReply(interaction, { ephemeral: false }))) return;

    if (recipientUser.bot) {
      const embed = buildEmbed({
        title: 'Tip Failed ⚠️',
        description: 'You cannot tip bots.',
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
      return;
    }

    if (recipientUser.id === interaction.user.id) {
      const embed = buildEmbed({
        title: 'Tip Failed ⚠️',
        description: 'You cannot tip yourself.',
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
      return;
    }

    try {
      await ensureUser(interaction.user.id, interaction.user.username);
      const credited = await syncPaidInvoices(interaction.user.id);
      for (const entry of credited) {
        await sendDm(
          interaction.user,
          `<a:purpleflame:1501111816334479441> Deposit received: ${formatSats(entry.amount)}`
        );
      }

      const total = await applyTransfer({
        sender: { id: interaction.user.id, username: interaction.user.username },
        recipients: [{ id: recipientUser.id, username: recipientUser.username }],
        amountPer: amount,
        reason: 'tip',
      });

      console.log('Tip transfer total:', total);

      await safeEditReply(
        interaction,
        `<a:peperain:1501114711272460358> ${interaction.user.toString()} tipped ${recipientUser.toString()} ${formatSats(total)}`
      );

      await sendDm(
        recipientUser,
        `<a:peperain:1501114711272460358> ${interaction.user.toString()} tipped you ${formatSats(total)}`
      );
    } catch (error) {
      const embed = buildEmbed({
        title: 'Tip Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'rain') {
    const amount = interaction.options.getInteger('amount', true);
    const maxcount = interaction.options.getInteger('maxcount', true);

    if (!(await safeDeferReply(interaction, { ephemeral: false }))) return;

    const preparingEmbed = buildEmbed({
      title: '<a:rain:1501110375154978916> Preparing Rain',
      description: '<a:peperain:1501114711272460358> Scanning channel for active users...',
      color: 0x8e44ad,
    });
    await safeEditReply(interaction, { embeds: [preparingEmbed] });

    if (!interaction.inGuild() || !interaction.channel || !interaction.channel.isTextBased()) {
      const embed = buildEmbed({
        title: 'Rain Failed ⚠️',
        description: 'Rain can only be used in a server text channel.',
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
      return;
    }

    try {
      const recipients = await getRecentRecipients(interaction.channel, interaction.user.id, maxcount);

      console.log('Rain recipients:', recipients);

      if (recipients.length === 0) {
        const embed = buildEmbed({
          title: 'Rain Failed ⚠️',
          description: 'No recent users found in this channel.',
          color: 0xe74c3c,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      await ensureUser(interaction.user.id, interaction.user.username);
      const credited = await syncPaidInvoices(interaction.user.id);
      for (const entry of credited) {
        await sendDm(
          interaction.user,
          `<a:purpleflame:1501111816334479441> Deposit received: ${formatSats(entry.amount)}`
        );
      }

      const total = await applyTransfer({
        sender: { id: interaction.user.id, username: interaction.user.username },
        recipients,
        amountPer: amount,
        reason: 'rain',
      });

      console.log('Rain transfer total:', total);

      const recipientMentions = recipients.map((recipient) => `<@${recipient.id}>`);
      const listed = recipientMentions.slice(0, 10);
      const remaining = recipientMentions.length - listed.length;
      const listLines = listed.map(
        (mention) => `<:slice:1501114342631014480> ${mention} +${amount} <:_sats:1501104690790662216>`
      );
      if (remaining > 0) {
        listLines.push(`<:slice:1501114342631014480> ... and ${remaining} more users`);
      }

      const embed = new EmbedBuilder()
        .setColor(0x8e44ad)
        .setDescription(
          [
            '<a:rain:1501110375154978916> **Rain**',
            `${interaction.user.toString()} is making it rain!`,
            '',
            '<a:peperain:1501114711272460358> **Rain Summary**',
            `<a:purpleflame:1501111816334479441> Total Amount: ${formatSats(total)}`,
            `<a:purpleflame:1501111816334479441> Per User: ${formatSats(amount)}`,
            `<a:purpleflame:1501111816334479441> Recipients: ${recipients.length} users`,
            '',
            '<a:bump:1501113105994879088> **Lucky Recipients**',
            listLines.join('\n'),
          ].join('\n')
        );

      await safeEditReply(interaction, { embeds: [embed] });

      for (const recipient of recipients) {
        const user = await client.users.fetch(recipient.id);
        await sendDm(
          user,
          `<a:rain:1501110375154978916> ${interaction.user.toString()} rained you ${formatSats(amount)}`
        );
      }
    } catch (error) {
      const embed = buildEmbed({
        title: 'Rain Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'history') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;

    try {
      await ensureUser(interaction.user.id, interaction.user.username);
      await syncPaidInvoices(interaction.user.id);

      const history = await query(
        'select delta_sats, reason, created_at from balance_ledger where discord_id = $1 order by created_at desc limit 10',
        [interaction.user.id]
      );

      console.log('History rows:', history.rows);

      if (history.rows.length === 0) {
        const embed = buildEmbed({
          title: 'History 🧾',
          description: 'No balance activity yet.',
          color: 0x95a5a6,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      const lines = history.rows.map((entry) => {
        const delta = Number(entry.delta_sats);
        const signed = delta > 0 ? `+${delta}` : `${delta}`;
        const when = Math.floor(new Date(entry.created_at).getTime() / 1000);
        const direction = delta >= 0 ? '<:in:1501119632352870481>' : '<:out:1501119649339936813>';
        return `• ${direction} ${signed} <:_sats:1501104690790662216> — ${formatReason(entry.reason)} <t:${when}:R>`;
      });

      const embed = buildEmbed({
        title: 'History 🧾',
        description: truncateText(lines.join('\n'), 3900),
        color: 0xf2c14e,
      });

      await safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
      const embed = buildEmbed({
        title: 'History Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'leaderboard') {
    if (!(await safeDeferReply(interaction, { ephemeral: false }))) return;

    try {
      const leaderboardType = interaction.options.getString('type') || 'makers';
      const isCatchers = leaderboardType === 'catchers';

      const result = await query(
        isCatchers
          ? "select u.discord_id, u.discord_username, sum(b.delta_sats) as total_sats, count(*) as rains " +
              "from balance_ledger b join users u on u.discord_id = b.discord_id " +
              "where b.reason like 'rain:from:%' and b.delta_sats > 0 " +
              "group by u.discord_id, u.discord_username " +
              "order by total_sats desc limit 10"
          : "select u.discord_id, u.discord_username, sum(-b.delta_sats) as total_sats, count(*) as rains " +
              "from balance_ledger b join users u on u.discord_id = b.discord_id " +
              "where b.reason like 'rain:out:%' and b.delta_sats < 0 " +
              "group by u.discord_id, u.discord_username " +
              "order by total_sats desc limit 10"
      );

      const rankResult = await query(
        isCatchers
          ? "select discord_id, total_sats, rains, rank from (" +
              "select u.discord_id, sum(b.delta_sats) as total_sats, count(*) as rains, " +
              "dense_rank() over (order by sum(b.delta_sats) desc) as rank " +
              "from balance_ledger b join users u on u.discord_id = b.discord_id " +
              "where b.reason like 'rain:from:%' and b.delta_sats > 0 " +
              "group by u.discord_id" +
              ") ranked where discord_id = $1"
          : "select discord_id, total_sats, rains, rank from (" +
              "select u.discord_id, sum(-b.delta_sats) as total_sats, count(*) as rains, " +
              "dense_rank() over (order by sum(-b.delta_sats) desc) as rank " +
              "from balance_ledger b join users u on u.discord_id = b.discord_id " +
              "where b.reason like 'rain:out:%' and b.delta_sats < 0 " +
              "group by u.discord_id" +
              ") ranked where discord_id = $1",
        [interaction.user.id]
      );

      if (result.rows.length === 0) {
        const titlePrefix = isCatchers ? 'Catchers' : 'Makers';
        const embed = buildEmbed({
          title: `<a:rain:1501110375154978916> ${titlePrefix} Leaderboard`,
          description: 'No rain activity yet.',
          color: 0x95a5a6,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      const lines = result.rows.map((row, index) => {
        const rank = index + 1;
        const rankBadge = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '<:slice:1501114342631014480>';
        const mention = `<@${row.discord_id}>`;
        const total = Number(row.total_sats || 0);
        const rainCount = Number(row.rains || 0);
        return `${rankBadge} **${rank}.** ${mention} — ${formatSats(total)} · ${rainCount} rains`;
      });

      const userRow = rankResult.rows[0];
      const isInTop = result.rows.some((row) => row.discord_id === interaction.user.id);
      if (userRow && !isInTop) {
        const userTotal = Number(userRow.total_sats || 0);
        const userRains = Number(userRow.rains || 0);
        lines.push('------------------------------');
        lines.push('Your position:');
        lines.push(
          `<a:bump:1501113105994879088> **${userRow.rank}.** <@${interaction.user.id}> — ${formatSats(userTotal)} · ${userRains} rains`
        );
      }

      const titlePrefix = isCatchers ? 'Catchers' : 'Makers';
      const embed = buildEmbed({
        title: `<a:rain:1501110375154978916> ${titlePrefix} Leaderboard`,
        description: truncateText(lines.join('\n'), 3900),
        color: 0x3498db,
      });

      await safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
      const embed = buildEmbed({
        title: 'Leaderboard Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'help') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;

    const embed = buildEmbed({
      title: 'Help 📖',
      description: [
        '**/deposit amount** — Create a Lightning invoice + QR to add balance',
        '**/balance** — Show wallet balance and linked address',
        '**/history** — Show last 10 balance entries',
        '**/link address** — Link a Lightning address (name@domain)',
        '**/withdraw amount** — Withdraw to your linked Lightning address',
        '**/pay payreq** — Pay a Lightning invoice from your balance',
        '**/tip user amount** — Tip a user from your balance (public)',
        '**/rain amount maxcount** — Rain sats on recent users in a channel',
        '**/leaderboard type** — Top makers or catchers',
      ].join('\n'),
      color: 0x9b59b6,
    });

    await safeEditReply(interaction, { embeds: [embed] });
  }

  if (interaction.commandName === 'link') {
    const address = interaction.options.getString('address', true).trim();

    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;

    if (!address.includes('@')) {
      const embed = buildEmbed({
        title: 'Link Failed ⚠️',
        description: 'Invalid lightning address. Use name@domain.',
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
      return;
    }

    try {
      await ensureUser(interaction.user.id, interaction.user.username);
      await validateLightningAddress(address);
      await query('update users set lightning_address = $1 where discord_id = $2', [
        address,
        interaction.user.id,
      ]);

      const embed = buildEmbed({
        title: 'Address Linked ✅',
        description: `Linked ${address} for withdrawals.`,
        color: 0x2ecc71,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
      const embed = buildEmbed({
        title: 'Link Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'pay') {
    const payreq = interaction.options.getString('payreq', true);
    let amountSats;
    let reserved = false;

    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;

    try {
      await ensureUser(interaction.user.id, interaction.user.username);
      await syncPaidInvoices(interaction.user.id);

      let decoded;
      try {
        decoded = bolt11.decode(payreq);
      } catch (error) {
        const embed = buildEmbed({
          title: 'Payment Failed ⚠️',
          description: 'Invalid Lightning invoice.',
          color: 0xe74c3c,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      amountSats = null;
      if (decoded.satoshis) {
        amountSats = Number(decoded.satoshis);
      } else if (decoded.millisatoshis) {
        const msats = Number(decoded.millisatoshis);
        amountSats = Math.ceil(msats / 1000);
      }

      if (!amountSats || Number.isNaN(amountSats) || amountSats <= 0) {
        const embed = buildEmbed({
          title: 'Payment Failed ⚠️',
          description: 'Invoice must include an amount.',
          color: 0xe74c3c,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      try {
        await reserveWithdrawBalance(interaction.user.id, interaction.user.username, amountSats, 'pay');
        reserved = true;
      } catch (error) {
        const message =
          error && error.message === 'Insufficient balance.'
            ? `Insufficient balance. Needed ${formatSats(amountSats)}.`
            : truncateText(error.message || 'Unable to reserve balance.', 200);
        const embed = buildEmbed({
          title: 'Payment Failed ⚠️',
          description: message,
          color: 0xe74c3c,
        });
        await safeEditReply(interaction, { embeds: [embed] });
        return;
      }

      const data = await coinosRequest('/payments', 'POST', {
        payreq,
        pin: COINOS_PIN,
      });

      console.log('Pay response:', data);

      const fields = [];
      if (data && data.amount) fields.push({ name: 'Amount', value: formatSats(data.amount), inline: true });
      if (data && data.hash) fields.push({ name: 'Hash', value: truncateText(data.hash, 64), inline: true });

      const embed = buildEmbed({
        title: 'Payment Sent ✅',
        description: 'Payment broadcast to Lightning network.',
        color: 0x2ecc71,
        fields,
      });

      await safeEditReply(interaction, { embeds: [embed] });

      if (data && data.amount) {
        const amount = Math.abs(Number(data.amount));
        await sendDm(
          interaction.user,
          `<a:purpleflame:1501111816334479441> Your withdrawal of ${formatSats(amount)} was successful!`
        );
      }
    } catch (error) {
      if (reserved && typeof amountSats === 'number' && amountSats > 0) {
        await refundWithdrawBalance(interaction.user.id, amountSats, 'pay');
      }
      const embed = buildEmbed({
        title: 'Payment Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });
      await safeEditReply(interaction, { embeds: [embed] });
    }
  }

  if (interaction.commandName === 'admin') {
    try {
      await handleAdminCommand(interaction, query, coinosRequest);
    } catch (error) {
      console.error('Admin command failed:', error.message);
      const embed = buildEmbed({
        title: 'Admin Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });

      try {
        if (interaction.deferred || interaction.replied) {
          await safeEditReply(interaction, { embeds: [embed], components: [] });
        } else {
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      } catch (responseError) {
        console.error('Failed to send admin error response:', responseError.message);
      }
    }
  }

  if (interaction.commandName === 'userstats') {
    try {
      await handleUserStatsCommand(interaction, query);
    } catch (error) {
      console.error('User stats command failed:', error.message);
      const embed = buildEmbed({
        title: 'User Stats Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });

      try {
        if (interaction.deferred || interaction.replied) {
          await safeEditReply(interaction, { embeds: [embed], components: [] });
        } else {
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      } catch (responseError) {
        console.error('Failed to send user stats error response:', responseError.message);
      }
    }
  }

  if (interaction.commandName === 'changestatus') {
    try {
      await handleChangeStatusCommand(interaction, query);
    } catch (error) {
      console.error('Change status command failed:', error.message);
      const embed = buildEmbed({
        title: 'Change Status Failed ⚠️',
        description: truncateText(error.message, 200),
        color: 0xe74c3c,
      });

      try {
        if (interaction.deferred || interaction.replied) {
          await safeEditReply(interaction, { embeds: [embed], components: [] });
        } else {
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      } catch (responseError) {
        console.error('Failed to send change status error response:', responseError.message);
      }
    }
  }
});

client.login(DISCORD_TOKEN);
