const { createVotingModule } = require('./voting');
const { createEchoModule } = require('./echo');
const { createLockModule } = require('./lock');
const { createBtcPriceModule } = require('./btcprice');
const { createRedditModule } = require('./reddit');
const { createRedditArtModule } = require('./reddit-art');
const { createHelpModule } = require('./help');

function createFeatures(config) {
  const voting = createVotingModule(config.voting);
  const modules = [
    voting,
    createEchoModule(config.echo),
    createLockModule(config.lock),
    createBtcPriceModule(),
    createRedditModule({ ...config.reddit, allowedStarterIds: config.voting.voteStarterIds }),
    createRedditArtModule({ ...config.redditArt, allowedStarterIds: config.voting.voteStarterIds }),
  ];
  modules.push(createHelpModule({ getCommands: () => modules.flatMap((module) => module.buildCommands()) }));
  return { modules, voting };
}

module.exports = { createFeatures };
