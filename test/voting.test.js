const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVotingModule } = require('../src/features/voting');

test('button votes survive restarting the module and duplicate votes stay rejected', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sliceboi-test-'));
  const settings = { dbFile: path.join(directory, 'vote.db'), voteStarterIds: new Set(['starter']) };
  let voting = createVotingModule(settings);
  t.after(() => {
    voting.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const posts = [];
  const replies = [];
  const channel = {
    send: async (post) => { posts.push(post); return { id: `message-${posts.length}` }; },
    isTextBased: () => true,
  };
  const base = {
    inGuild: () => true, guildId: 'guild', channelId: 'channel', channel,
    reply: async (response) => replies.push(response),
    client: { channels: { fetch: async () => channel } },
  };
  await voting.handleInteraction({
    ...base, isButton: () => false, isChatInputCommand: () => true,
    commandName: 'start-vote', user: { id: 'starter', username: 'Starter' },
    options: {
      getInteger: () => 1,
      getString: (name) => ({ type: 'meme', entry1: 'https://example.com/1', entry2: 'https://example.com/2' })[name] || null,
    },
  });
  assert.equal(voting.getActiveCount(), 1);
  const button = {
    ...base, isButton: () => true, isChatInputCommand: () => false,
    customId: posts[0].components[0].components[0].data.custom_id,
    user: { id: 'participant', username: 'Participant' },
  };
  await voting.handleInteraction(button);
  assert.match(replies.at(-1).content, /Vote recorded/);
  voting.close();
  voting = createVotingModule(settings);
  assert.equal(voting.getActiveCount(), 1);
  await voting.handleInteraction(button);
  assert.match(replies.at(-1).content, /already voted/);
  await voting.handleInteraction({
    ...base, isButton: () => false, isChatInputCommand: () => true,
    commandName: 'end-vote', user: { id: 'starter' }, options: { getString: () => 'meme' },
  });
  assert.equal(voting.getActiveCount(), 0);
});
