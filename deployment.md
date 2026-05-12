# Deployment (GitHub + Docker on a VM)

## 1) Prepare .env

Create a `.env` file on the VM (same folder as `Dockerfile`):

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
COINOS_TOKEN=...
COINOS_PIN=...
DATABASE_URL=...
```

## 2) Deploy from GitHub on a VM

1. Install Docker and Git on your VM.
2. Clone the repo:

```bash
git clone https://github.com/<your-org>/<your-repo>.git
cd <your-repo>
```

3. Build and run:

```bash
docker build -t paybot:latest .

docker run -d \
  --name paybot \
  --env-file .env \
  paybot:latest
```

## 4) Update on the VM

```bash
cd <your-repo>
git pull

docker stop paybot
docker rm paybot

docker build -t paybot:latest .

docker run -d \
  --name paybot \
  --env-file .env \
  paybot:latest
```
