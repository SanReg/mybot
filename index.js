require('dotenv').config();

const { loadConfig } = require('./src/config');
const { startBot } = require('./src/bot');

startBot(loadConfig());
