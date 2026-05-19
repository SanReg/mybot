const { EmbedBuilder } = require('discord.js');
const { pool, query } = require('./db');

const MENTION_REGEX = /<@!?(\d+)>/g;

function truncateText(value, maxLength) {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatSats(amount) {
  return `${amount} <:_sats:1501104690790662216>`;
}

async function ensureUser(discordId, discordUsername) {
  await query(
    'insert into users (discord_id, discord_username) values ($1, $2) on conflict (discord_id) do update set discord_username = excluded.discord_username',
    [discordId, discordUsername]
  );
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

async function getMentionedIds(message) {
  const ids = new Set();

  for (const user of message.mentions.users.values()) {
    ids.add(user.id);
  }

  let match;
  while ((match = MENTION_REGEX.exec(message.content || '')) !== null) {
    ids.add(match[1]);
  }

  return [...ids];
}

async function handleTipMessage(message) {
  const text = message.content ? message.content.trim() : '';
  if (!text.toLowerCase().startsWith('$tip ')) return false;

  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    await message.reply('Usage: `$tip <@user> [<@user>...] <amount>`');
    return true;
  }

  const amountArg = parts[parts.length - 1];
  const amount = Number(amountArg);
  if (!Number.isInteger(amount) || amount <= 0) {
    await message.reply('Please specify a valid integer satoshi amount at the end of the command.');
    return true;
  }

  const mentionIds = await getMentionedIds(message);
  const recipientIds = mentionIds.filter((id) => id !== message.author.id);

  if (recipientIds.length === 0) {
    await message.reply('Please mention at least one user to tip, and do not include yourself.');
    return true;
  }

  const recipients = [];
  for (const id of recipientIds) {
    try {
      const user = await message.client.users.fetch(id);
      if (!user || user.bot) continue;
      if (user.id === message.author.id) continue;
      recipients.push({ id: user.id, username: user.username });
    } catch {
      // Ignore invalid or unfetchable users.
    }
  }

  if (recipients.length === 0) {
    await message.reply('No valid recipients were found. Make sure the mentions are correct and not bots.');
    return true;
  }

  try {
    await ensureUser(message.author.id, message.author.username);

    const total = await applyTransfer({
      sender: { id: message.author.id, username: message.author.username },
      recipients,
      amountPer: amount,
      reason: 'tip',
    });

    const recipientMentions = recipients.map((recipient) => `<@${recipient.id}>`).join(', ');
    await message.reply(
      `<a:peperain:1501114711272460358> ${message.author.toString()} tipped ${recipientMentions} ${formatSats(amount)} each`
    );

    for (const recipient of recipients) {
      try {
        const user = await message.client.users.fetch(recipient.id);
        await user.send(`<a:peperain:1501114711272460358> ${message.author.toString()} tipped you ${formatSats(amount)}`);
      } catch (error) {
        console.error(`Failed to DM tip recipient ${recipient.id}:`, error.message);
      }
    }
  } catch (error) {
    const embed = new EmbedBuilder()
      .setTitle('Tip Failed ⚠️')
      .setDescription(truncateText(error.message || 'Failed to send tip.', 200))
      .setColor(0xe74c3c);
    await message.reply({ embeds: [embed] });
  }

  return true;
}

module.exports = {
  handleTipMessage,
};
