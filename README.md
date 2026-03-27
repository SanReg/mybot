# Quiz + Vote Discord Bot (Node.js)

This bot provides:
- Quiz mode: `/question name:<text> answer:<text>` by authorized users only.
- Voting mode: `/start-vote duration:<minutes> number:<n>` by authorized users only, and `/vote number:<x>` by users with a required role.
- Health endpoint: `GET /health` on `PORT` (default `3000`).

## Features implemented

1. Quiz bot
- Only Discord user IDs in `QUIZ_MASTER_IDS` can run `/question`.
- Question is posted in the same channel.
- Users can also answer by sending a normal message in that channel.
- First correct answer: `100` points, second: `60`, third: `40`.
- Winner usernames and per-question points are recorded in memory.
- Total user points are tracked in a global in-memory scoreboard (`/scoreboard`).

2. Vote bot
- Only IDs in `VOTE_STARTER_IDS` can run `/start-vote`.
- Vote range is `1..n` where `n` is the `number` argument.
- Only users with role `VOTER_ROLE_ID` can run `/vote`.
- Each participant can vote exactly 3 times, and all 3 must be different valid numbers.
- Username and number for each vote are recorded in memory.
- `/vote-results` shows current standings.

## Setup

1. Create a Discord bot in the Discord Developer Portal.
2. Enable bot intents:
- `SERVER MEMBERS INTENT` (optional for this bot)
- `MESSAGE CONTENT INTENT` (required for quiz answer messages)
3. Invite the bot to your server with `applications.commands` and bot permissions.

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` and set values:

```env
DISCORD_TOKEN=...
CLIENT_ID=...
GUILD_IDS=111111111111111111,222222222222222222 # optional test guild list
GUILD_ID=111111111111111111 # optional legacy fallback
PORT=3000
QUIZ_MASTER_IDS=111111111111111111,222222222222222222
VOTE_STARTER_IDS=111111111111111111,333333333333333333
VOTER_ROLE_ID=444444444444444444
QUIZ_TIMEOUT_SECONDS=600
ENABLE_QUIZ=false
```

`ENABLE_QUIZ=false` disables all quiz commands and quiz message handling.
Set `ENABLE_QUIZ=true` to re-enable quiz features.

## Run

```bash
npm start
```

## Health check

```bash
curl http://localhost:3000/health
```

Returns JSON like:

```json
{
  "status": "ok",
  "botReady": true,
  "activeQuizChannels": 0,
  "activeVoteChannels": 0,
  "timestamp": "2026-03-27T12:00:00.000Z"
}
```

## Notes

- Data is currently in-memory (resets on restart).
- Code is split into `quiz.js` and `voting.js`, wired by `index.js`.
- Slash commands are always registered globally so they work in every guild where the bot is installed.
- If `GUILD_IDS` or `GUILD_ID` is set, the bot also tries a fast test-guild sync for those IDs.
- Invalid test guild IDs are skipped with a warning and no longer crash bot startup.
