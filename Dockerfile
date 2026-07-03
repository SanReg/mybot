FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_DIR=/root/data/mybot

# Persistent SQLite storage. Mount a host dir or named volume here so vote.db
# survives container rebuilds/restarts.
VOLUME ["/root/data/mybot"]

EXPOSE 3000

CMD ["npm", "start"]