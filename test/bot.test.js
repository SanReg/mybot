const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { loadConfig } = require('../src/config');
const { createDiscordClient } = require('../src/discord/client');
const { createFeatures } = require('../src/features');
const { registerCommands } = require('../src/discord/commands');
const { createInteractionHandler } = require('../src/discord/interactions');
const { createHealthApp } = require('../src/http/health');
const { createLockModule } = require('../src/features/lock');
const { GatewayIntentBits } = require('discord.js');

function config() {
  return loadConfig({
    DISCORD_TOKEN: 'unused',
    VOTE_STARTER_IDS: 'starter', DB_FILE: ':memory:',
    GUILD_IDS: 'first, second', GUILD_ID: 'first',
    LOCK_MANAGER_ROLE_IDS: 'manager', LOCK_CHANNEL_ID: 'channel', LOCKED_ROLE_ID: 'locked',
    ENABLE_QUIZ: 'true',
  });
}

test('client requests only Guilds and has no message listener', async () => {
  const client = createDiscordClient();
  assert.equal(client.options.intents.bitfield, GatewayIntentBits.Guilds);
  assert.equal(client.listenerCount('messageCreate'), 0);
  await client.destroy();
});

test('registration replaces global and test commands without quiz commands', async (t) => {
  const settings = config();
  const { modules, voting } = createFeatures(settings);
  t.after(() => voting.close());
  const registered = [];
  const client = {
    application: { commands: { set: async (commands) => registered.push(['global', commands]) } },
    guilds: { fetch: async (id) => ({ commands: { set: async (commands) => registered.push([id, commands]) } }) },
  };
  await registerCommands(client, modules, settings.testGuildIds);
  assert.deepEqual(registered.map(([id]) => id), ['global', 'first', 'second']);
  const names = registered[0][1].map((command) => command.name).sort();
  assert.deepEqual(names, [
    'art-list', 'btc', 'echo', 'end-vote', 'lock', 'meme-list', 'my-votes',
    'remove-votes', 'start-vote', 'unlock', 'vote-details', 'vote-results',
  ].sort());
  assert.deepEqual(registered[1][1], registered[0][1]);
});

test('interaction routing sends buttons only to voting and commands to their module', async () => {
  const calls = [];
  const handler = createInteractionHandler([
    { handleInteraction: async () => { calls.push('voting'); return false; } },
    { handleInteraction: async () => { calls.push('echo'); return true; } },
    { handleInteraction: async () => { throw new Error('Should not be called'); } },
  ]);
  await handler({ isChatInputCommand: () => false, isButton: () => true });
  assert.deepEqual(calls, ['voting']);
  calls.length = 0;
  await handler({ isChatInputCommand: () => true, isButton: () => false });
  assert.deepEqual(calls, ['voting', 'echo']);
});

test('lock and unlock authorize roles supplied by cached and raw interaction members', async () => {
  const lock = createLockModule(config().lock);
  for (const commandName of ['lock', 'unlock']) {
    for (const roles of [['manager'], { cache: new Map([['manager', {}]]) }, ['other']]) {
      const edits = [];
      const replies = [];
      const channel = {
        isTextBased: () => true,
        permissionOverwrites: { edit: async (...args) => edits.push(args) },
        send: async () => {},
      };
      const interaction = {
        commandName, inGuild: () => true, member: { roles }, user: { id: 'user', tag: 'User' },
        guild: { channels: { fetch: async () => channel } }, reply: async (response) => replies.push(response),
      };
      assert.equal(await lock.handleInteraction(interaction), true);
      const allowed = Array.isArray(roles) ? roles.includes('manager') : true;
      assert.equal(edits.length, allowed ? 1 : 0);
      if (allowed) assert.equal(edits[0][1].SendMessages, commandName === 'unlock');
      else assert.match(replies[0].content, /not allowed/);
    }
  }
});

test('health diagnostics and readiness track the Discord connection', async (t) => {
  let ready = false;
  const app = createHealthApp({
    client: { isReady: () => ready }, voting: { getActiveCount: () => 2 },
    state: { discordLoginStartedAt: 'started', lastDiscordLoginError: 'diagnostic' },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.activeVoteChannels, 2);
  assert.equal(health.discordLoginError, 'diagnostic');
  assert.equal('activeQuizChannels' in health, false);
  assert.equal((await fetch(`${url}/ready`)).status, 503);
  ready = true;
  const response = await fetch(`${url}/ready`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ready');
});
