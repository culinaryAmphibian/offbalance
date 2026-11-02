# The real HTTPS server (server/server.ts) against the chain container (deploy/server-entrypoint.sh)
FROM node:24-bookworm-slim

# openssl: scripts/dev-cert.ts; curl: the healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
# seed.ts reads the dev wallets from the repo root
COPY dev.env /app/dev.env
COPY deploy/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh

EXPOSE 5000
# every 2s while starting, then every 30s (each check is a line in the request log)
HEALTHCHECK --interval=30s --timeout=3s --start-period=90s --start-interval=2s --retries=3 \
    CMD curl -fsk https://127.0.0.1:5000/config > /dev/null
ENTRYPOINT ["sh", "/usr/local/bin/server-entrypoint.sh"]
