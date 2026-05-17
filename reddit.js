const { XMLParser } = require('fast-xml-parser');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const DEFAULT_FEED_URL = 'https://www.reddit.com/r/ecils/new/.rss';
const DEFAULT_CHANNEL_ID = '931635666922651719';
const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_MAX_POST_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MEMORY_TTL_MS = 20 * 60 * 1000;

function startRedditRelayLoop({
  client,
  channelId = DEFAULT_CHANNEL_ID,
  feedUrl = DEFAULT_FEED_URL,
  pollIntervalMs = DEFAULT_POLL_MS,
  maxPostAgeMs = DEFAULT_MAX_POST_AGE_MS,
  memoryTtlMs = DEFAULT_MEMORY_TTL_MS,
}) {
  if (!client) {
    throw new Error('startRedditRelayLoop requires a Discord client.');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });

  const postedMemory = new Map();
  let running = false;

  const runCycle = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.warn(`[REDDIT] Channel ${channelId} is missing or not text-based.`);
        return;
      }

      const items = await fetchFeedItems({ feedUrl, parser });
      if (items.length === 0) {
        pruneMemory({ postedMemory, memoryTtlMs, nowMs: Date.now() });
        return;
      }

      const nowMs = Date.now();
      pruneMemory({ postedMemory, memoryTtlMs, nowMs });

      const freshItems = items
        .filter((item) => {
          if (postedMemory.has(item.id)) {
            return false;
          }

          if (!Number.isFinite(item.publishedAtMs) || item.publishedAtMs <= 0) {
            return false;
          }

          const ageMs = nowMs - item.publishedAtMs;
          return ageMs >= 0 && ageMs <= maxPostAgeMs;
        })
        .sort((a, b) => a.publishedAtMs - b.publishedAtMs);

      for (const item of freshItems) {
        const message = formatDiscordMessage(item);
        await channel.send({
          content: message,
          allowedMentions: { parse: [] },
        });

        postedMemory.set(item.id, nowMs);

        console.log(`[REDDIT] Posted new item: ${item.title} (${item.link})`);
      }

      pruneMemory({ postedMemory, memoryTtlMs, nowMs: Date.now() });
    } catch (error) {
      console.error('[REDDIT] relay cycle failed:', error.message || error);
    } finally {
      running = false;
    }
  };

  runCycle().catch((error) => {
    console.error('[REDDIT] initial cycle failed:', error.message || error);
  });

  const timer = setInterval(() => {
    runCycle().catch((error) => {
      console.error('[REDDIT] scheduled cycle failed:', error.message || error);
    });
  }, pollIntervalMs);

  console.log(
    `[REDDIT] Relay loop started. feed=${feedUrl} channel=${channelId} poll=${Math.round(
      pollIntervalMs / 1000
    )}s maxAge=${Math.round(maxPostAgeMs / 60000)}m memoryTTL=${Math.round(memoryTtlMs / 60000)}m`
  );

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function fetchFeedItems({ feedUrl, parser }) {
  const response = await fetch(feedUrl, {
    headers: {
      'user-agent': 'quizbot-discord-reddit-relay/1.0',
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching RSS feed.`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);
  const itemsArray = extractFeedEntries(parsed);

  return itemsArray
    .map((entry) => {
      const link = firstText(entry.link, entry['atom:link'], entry.url);
      const guid = firstText(entry.guid, entry.id);
      const title = firstText(entry.title) || 'Untitled post';
      const id = guid || link || `${title}-${firstText(entry.pubDate)}`;
      const publishedAtText = firstText(entry.pubDate, entry.published, entry.updated);
      const publishedAtMs = Date.parse(publishedAtText || '') || 0;

      return {
        id: String(id).trim(),
        title: String(title).trim(),
        link: String(link || '').trim(),
        publishedAtMs,
      };
    })
    .filter((item) => item.id.length > 0 && item.link.length > 0);
}

function extractFeedEntries(parsed) {
  const rssItems = parsed && parsed.rss && parsed.rss.channel && parsed.rss.channel.item;
  const atomEntries = parsed && parsed.feed && parsed.feed.entry;

  const fromRss = Array.isArray(rssItems) ? rssItems : rssItems ? [rssItems] : [];
  const fromAtom = Array.isArray(atomEntries) ? atomEntries : atomEntries ? [atomEntries] : [];

  if (fromAtom.length > 0) {
    return fromAtom;
  }

  return fromRss;
}

function formatDiscordMessage(item) {
  const title = item.title.length > 220 ? `${item.title.slice(0, 217)}...` : item.title;
  const vxLink = transformLink(item.link);
  return `New MEME in r/ecils\nMeme Title: ${title}\n${vxLink}`;
}

function transformLink(link) {
  if (!link || typeof link !== 'string') return '';

  // Replace common reddit host variants with vxreddit.com for better media preview.
  return link.replace(/:\/\/(?:www\.|old\.|m\.)?reddit\.com/i, '://vxreddit.com');
}

function pruneMemory({ postedMemory, memoryTtlMs, nowMs }) {
  for (const [postId, postedAtMs] of postedMemory.entries()) {
    if (nowMs - postedAtMs > memoryTtlMs) {
      postedMemory.delete(postId);
    }
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = toText(value);
    if (text) {
      return text;
    }
  }

  return '';
}

function toText(value) {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = toText(item);
      if (found) {
        return found;
      }
    }
    return '';
  }

  if (typeof value === 'object') {
    if (typeof value['#text'] === 'string') {
      return value['#text'].trim();
    }

    if (typeof value['@_href'] === 'string') {
      return value['@_href'].trim();
    }

    if (typeof value.href === 'string') {
      return value.href.trim();
    }
  }

  return '';
}

module.exports = {
  startRedditRelayLoop,
};

function createRedditModule({ allowedStarterIds = new Set(), feedUrl = DEFAULT_FEED_URL, channelId = DEFAULT_CHANNEL_ID, parser = new XMLParser({ ignoreAttributes: false, trimValues: true }) } = {}) {
  function buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('meme-list')
        .setDescription('Post recent memes from the subreddit into the channel')
        .addIntegerOption((opt) =>
          opt.setName('days').setDescription('How many days back to include (integer)').setRequired(true)
        ),
    ];
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'meme-list') {
      return false;
    }

    const userId = interaction.user && interaction.user.id;
    if (!allowedStarterIds || !allowedStarterIds.has(userId)) {
      await interaction.reply({ content: "You don't have permission to run this command.", flags: 64 }).catch(() => null);
      return true;
    }

    const days = Math.max(0, Number(interaction.options.getInteger('days') || 0));
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

    await interaction.deferReply({ ephemeral: true });

    try {
      const items = await fetchFeedItems({ feedUrl, parser });
      const toPost = (items || [])
        .filter((it) => Number.isFinite(it.publishedAtMs) && it.publishedAtMs >= cutoffMs)
        .sort((a, b) => a.publishedAtMs - b.publishedAtMs);

      if (toPost.length === 0) {
        await interaction.editReply({ content: `No posts found in the last ${days} day(s).` }).catch(() => null);
        return true;
      }

      const channel = await interaction.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply({ content: 'Configured channel is not available.' }).catch(() => null);
        return true;
      }

      // Send a bold, prominent header (bold + underline) as plain text.
      await channel.send({ content: `**__Listing all memes in ${days} Day(s)__**`, allowedMentions: { parse: [] } }).catch(() => null);

      for (let i = 0; i < toPost.length; i++) {
        const item = toPost[i];
        const index = i + 1;
        const title = item.title.length > 220 ? `${item.title.slice(0, 217)}...` : item.title;
        const message = `Meme: ${index}, Meme Title: ${title}\n${transformLink(item.link)}`;
        await channel.send({ content: message, allowedMentions: { parse: [] } }).catch(() => null);
      }

      await interaction.editReply({ content: `Posted ${toPost.length} post(s) to the channel.` }).catch(() => null);
      return true;
    } catch (error) {
      console.error('[REDDIT] /meme-list failed:', error);
      await interaction.editReply({ content: 'Failed to fetch or post memes.' }).catch(() => null);
      return true;
    }
  }

  return {
    buildCommands,
    handleInteraction,
  };
}

module.exports = {
  startRedditRelayLoop,
  createRedditModule,
};
