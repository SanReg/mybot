const { ActivityType } = require('discord.js');
const https = require('https');

const BTC_QUOTE_URL = 'https://api.addslice.com/v1/quotes/BTC/USD';
const STATUS_REFRESH_SECONDS = 60;
const FALLBACK_STATUS_TEXT = 'addslice.com';

function startActivityStatusLoop({ client }) {
  let lastStatusText = FALLBACK_STATUS_TEXT;

  const applyPresence = (text) => {
    if (!client || !client.isReady() || !client.user) {
      return;
    }

    client.user.setPresence({
      activities: [{ name: text, type: ActivityType.Watching }],
      status: 'online',
    });
  };

  const refreshPresence = async () => {
    try {
      const quote = await fetchJson(BTC_QUOTE_URL);
      const rate = Number(quote && quote.data && quote.data.rate);

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('Invalid BTC rate in API response.');
      }

      const formattedRate = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(rate);

      lastStatusText = `BTC: ${formattedRate}`;
    } catch (error) {
      console.warn('[STATUS] BTC status refresh failed, keeping previous status:', error.message);
    }

    applyPresence(lastStatusText);
  };

  refreshPresence();

  setInterval(() => {
    refreshPresence().catch((error) => {
      console.warn('[STATUS] Unexpected refresh error:', error.message);
      applyPresence(lastStatusText);
    });
  }, STATUS_REFRESH_SECONDS * 1000);

  console.log(`[STATUS] Presence loop started. source=BTC/USD refreshEvery=${STATUS_REFRESH_SECONDS}s`);
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

module.exports = {
  startActivityStatusLoop,
};