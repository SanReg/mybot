# Quiz + Vote Discord Bot (Node.js)

cd mybot
git pull origin master
docker stop quizbot || true
docker rm quizbot || true
docker build -t quizbot .
docker run -d --name quizbot --restart unless-stopped --env-file .env -p 3000:3000 quizbot
docker logs -f quizbot

This bot provides:
- Quiz mode: `/question name:<text> answer:<text>` by authorized users only.
- Quiz scoreboard reset: `/reset` by quiz masters only.
- Voting mode: `/start-vote duration:<minutes> number:<n>` by authorized users only, and `/vote number:<x>` by users with a required role.
- Echo mode: `/echo message:<text>` replies privately and posts the same text to the channel, restricted to allowed user IDs.
- Lock mode: `/lock` and `/unlock` allow users with configured manager roles to lock or unlock one configured channel for one configured role.
- BTC mode: `/btc` fetches current BTC/USD price and displays it in an embed.
- Activity status mode: a dedicated status loop fetches BTC/USD every 60 seconds and updates bot status to watch the current BTC price.
- Health endpoint: `GET /health` on `PORT` (default `3000`).

## Features implemented

1. Quiz bot
- Only Discord user IDs in `QUIZ_MASTER_IDS` can run `/question`.
- Question is posted in the same channel.
- Users can also answer by sending a normal message in that channel.
- First correct answer: `100` points, second: `60`, third: `40`.
- Winner usernames and per-question points are recorded in memory.
- Total user points are tracked in a global in-memory scoreboard (`/scoreboard`).
- Only IDs in `QUIZ_MASTER_IDS` can run `/reset` to clear the scoreboard.
- Successful `/reset` posts in the same channel as `<@userId> reset the leaderboard.` and is logged on the server.

2. Vote bot
- Only IDs in `VOTE_STARTER_IDS` can run `/start-vote`.
- Vote range is `1..n` where `n` is the `number` argument.
- Only users with role `VOTER_ROLE_ID` can run `/vote`.
- Each participant can vote exactly 3 times, and all 3 must be different valid numbers.
- Username and number for each vote are recorded in memory.
- `/vote-results` shows current standings.

3. Echo bot
- `/echo message:<text>` sends a private confirmation and repeats the same message publicly in the same channel.
- Only users listed in `ECHO_MASTER_IDS` can use `/echo`.

4. Lock bot
- `/lock` updates channel permissions so users with role `LOCKED_ROLE_ID` cannot send messages in `LOCK_CHANNEL_ID`.
- `/unlock` explicitly allows `LOCKED_ROLE_ID` to send messages in `LOCK_CHANNEL_ID`.
- Only members with at least one role from `LOCK_MANAGER_ROLE_IDS` can run `/lock`.
- Only members with at least one role from `LOCK_MANAGER_ROLE_IDS` can run `/unlock`.
- Both commands post an embed message in `LOCK_CHANNEL_ID` showing who triggered the action.
- The command is registered only when all lock env values are configured.

5. BTC price bot
- `/btc` fetches the latest BTC/USD quote from `https://api.addslice.com/v1/quotes/BTC/USD`.
- Displays `data.rate` in an embed with requester details.
- Also shows `1000 slices = <sats>` in the same embed.

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
ECHO_MASTER_IDS=111111111111111111,222222222222222222
LOCK_MANAGER_ROLE_IDS=555555555555555555,666666666666666666
LOCK_CHANNEL_ID=777777777777777777
LOCKED_ROLE_ID=888888888888888888
QUIZ_TIMEOUT_SECONDS=600
ENABLE_QUIZ=false
```

`ENABLE_QUIZ=false` disables all quiz commands and quiz message handling.
Set `ENABLE_QUIZ=true` to re-enable quiz features.

## Run

```bash
npm start
```

## Deploy On Ubuntu VM (Docker)

### 1. Install Docker on the VM

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Copy or clone the bot project

```bash
git clone <your-repo-url> quizBot
cd quizBot
```

### 3. Create your `.env` file

```bash
cp .env.example .env
nano .env
```

If your repo does not have `.env.example`, create `.env` manually with the required values.

### 4. Build the Docker image

```bash
docker build -t quizbot:latest .
```

### 5. Run the container

```bash
docker run -d \
  --name quizbot \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  quizbot:latest
```

### 6. Verify bot and health endpoint

```bash
docker ps
docker logs -f quizbot
curl http://localhost:3000/health
```

### 7. Update after code changes

```bash
docker stop quizbot
docker rm quizbot
docker build -t quizbot:latest .
docker run -d \
  --name quizbot \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  quizbot:latest
```

If you use a cloud firewall/security group, allow inbound TCP on port `3000` only if you need external access to `/health`.

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
- Code is split into `quiz.js`, `voting.js`, `echo.js`, `lock.js`, `btcprice.js`, and `status.js`, wired by `index.js`.
- Slash commands are always registered globally so they work in every guild where the bot is installed.
- If `GUILD_IDS` or `GUILD_ID` is set, the bot also tries a fast test-guild sync for those IDs.
- Invalid test guild IDs are skipped with a warning and no longer crash bot startup.
