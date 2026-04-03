const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const https = require('https');

const BTC_QUOTE_URL = 'https://api.addslice.com/v1/quotes/BTC/USD';
const SATS_PER_BTC = 100_000_000;
const SLICES_PER_USD = 1000;

function createBtcPriceModule() {
  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('btc')
        .setDescription('Show the current BTC/USD price.'),
    ];
  }

  async function handleInteraction(interaction) {
    if (interaction.commandName !== 'btc') {
      return false;
    }

    await handleBtcCommand(interaction);
    return true;
  }

  async function handleBtcCommand(interaction) {
    await interaction.deferReply();

    try {
      const quote = await fetchJson(BTC_QUOTE_URL);
      const rate = Number(quote && quote.data && quote.data.rate);

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('Invalid BTC quote format from upstream API.');
      }

      const formattedRate = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(rate);

      const satsPer1000Slices = SATS_PER_BTC / rate;
      const formattedSatsPer1000Slices = formatNumber(satsPer1000Slices, 2, 8);

      const embed = new EmbedBuilder()
        .setColor(0xf7931a)
        .setTitle('Bitcoin Price (BTC/USD)')
        .setDescription(`**${formattedRate}**`)
        .addFields(
          { name: 'Pair', value: 'BTC / USD', inline: true },
          { name: 'Requested By', value: `<@${interaction.user.id}>`, inline: true },
          { name: '1000 Slices', value: `${formattedSatsPer1000Slices} sats`, inline: false }
        )
        .setFooter({ text: 'Live quote from Addslice API' })
        .setTimestamp(new Date());

      await interaction.editReply({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error('[BTC] failed to fetch quote:', error);
      await interaction.editReply({
        content: 'Could not fetch BTC price right now. Please try again in a moment.',
      });
    }
  }

  return {
    buildCommands,
    handleInteraction,
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timeout after 10s'));
    });

    req.on('error', reject);
  });
}

function formatNumber(value, minFractionDigits, maxFractionDigits) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

module.exports = {
  createBtcPriceModule,
};