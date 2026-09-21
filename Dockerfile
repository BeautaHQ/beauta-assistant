FROM node:20-slim

# openssl: required by Prisma's query engine at runtime.
RUN apt-get update -y && apt-get install -y \
  openssl \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copy package files
COPY package*.json ./
COPY prisma ./prisma

# install deps
RUN npm ci

# copy source
COPY . .

# Prisma needs directUrl to parse as a URL for `generate` to run at all; it is
# never connected to. See scripts/sync-schema.mjs.
ENV BEAUTA_VOICE_MUST_NOT_MIGRATE="postgresql://blocked:blocked@127.0.0.1:1/blocked?schema=blocked"

RUN npx prisma generate && npm run build

EXPOSE 3003

# No migrate step: beauta-api owns the schema and every migration. Bookings go
# through its HTTP API so a phone booking obeys the same conflict checks and
# confirmation emails as any other; the only table written here is
# `conversation`.
CMD ["node", "dist/server.js"]
