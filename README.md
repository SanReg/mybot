# sliceBoi

A Discord bot using slash commands and buttons. It requests only the non-privileged `Guilds` gateway intent.

## Features

- `/help` lists enabled commands, usage, and access restrictions in a private embed you can dismiss.
- Meme and art voting: `/start-vote`, `/end-vote`, `/my-votes`, `/vote-results`, `/vote-details`, and `/remove-votes`. Each user gets three votes for different entries. Vote starters manage rounds and view private results.
- `/echo message:<text>` posts text supplied through the command, restricted to `ECHO_MASTER_IDS`.
- `/lock` and `/unlock` change sending permissions for a configured role in a configured channel, restricted to `LOCK_MANAGER_ROLE_IDS`.
- `/btc` displays the BTC/USD quote and slice-to-satoshi conversion.
- A BTC price activity status updates every minute.
- Reddit meme and art relays poll every 5 minutes, post entries up to 10 minutes old, and remember posted IDs for 15 minutes. `/meme-list days:<number>` and `/art-list days:<number>` list recent posts, restricted to `VOTE_STARTER_IDS`.
- `/health` supplies diagnostics; `/ready` returns HTTP 503 until Discord is ready.

The message-based quiz and its `/question`, `/scoreboard`, and `/reset` commands have been removed. `ENABLE_QUIZ`, `QUIZ_MASTER_IDS`, and `QUIZ_TIMEOUT_SECONDS` are no longer used.

## Setup

Use Node.js 22.13 or later (Docker uses Node.js 24).

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Leave all three **Privileged Gateway Intents** switches off: Presence, Server Members, and Message Content.
3. Invite the bot with the `bot` and `applications.commands` scopes. Give it View Channels, Send Messages, and Embed Links permissions. Channel locking also needs Manage Roles permission to edit permission overwrites, with the bot role above the target role.
4. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`. The current voting implementation accepts any server member's vote.
5. Configure authorized user IDs, optional lock settings, Reddit feeds, and destination channels in `.env.example`.

Slash command values and member data arrive through [Discord interaction payloads](https://docs.discord.com/developers/interactions/receiving-and-responding). Reading users' ordinary messages is no longer needed. See [Discord's gateway documentation](https://docs.discord.com/developers/events/gateway) for privileged intent details.

```powershell
Copy-Item .env.example .env
npm ci
npm start
```

For local database storage, set `DB_DIR=.` or `DB_FILE=./vote.db`. By default the database remains at `/root/data/mybot/vote.db`, matching the existing Docker volume. `DB_FILE` takes precedence over `DB_DIR`. Existing SQLite data needs no migration and is preserved across this refactor. Legacy `vote.json` is retained but is not used by the current bot.

`GUILD_IDS` accepts comma-separated test server IDs; `GUILD_ID` is a legacy fallback. Commands are replaced globally and in configured test guilds on startup, removing old quiz commands from those scopes. Global changes may take time to appear. Any previously configured test guild must remain in the list for its old commands to be removed.

## Project structure

```text
index.js                   Environment loading and startup
src/
  config.js                Environment configuration
  bot.js                   Bot lifecycle and background tasks
  discord/
    client.js              Gateway intent configuration
    commands.js            Slash command registration
    interactions.js        Command and button routing
  features/                Voting, echo, lock, BTC, and Reddit modules
  services/status.js       BTC activity status loop
  http/health.js           Health and readiness endpoints
  utils/member-roles.js    Roles supplied by interactions
archive/voting.rollback.js Legacy JSON voting implementation, excluded from Docker
test/                      Offline regression tests
```

`npm run dev` watches for changes. `npm test` runs offline tests without signing into Discord or contacting external APIs.

## Docker

```bash
docker build -t sliceboi .
docker run -d \
  --name sliceboi \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  -v /root/data/mybot:/root/data/mybot \
  sliceboi
docker logs -f sliceboi
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

Mount the same database directory when rebuilding or replacing the container. `.env` and local SQLite files are excluded from the image.

`PORT` defaults to 3000. The health server starts after command registration, or after `HEALTH_SERVER_START_TIMEOUT_MS` (default 25000) if login is still pending, or immediately on login failure. `/health` reports readiness, login diagnostics, and the active vote count. `/ready` checks the Discord connection, not the availability of Reddit or BTC APIs.
