# Hardhat node with OffBalance deployed (deploy/chain-entrypoint.sh)
FROM node:24-bookworm-slim

# forge-std is a GitHub dependency pinned over git+ssh in the lockfile; fetch it over HTTPS instead
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app/blockchain
COPY blockchain/package.json blockchain/package-lock.json ./
RUN npm ci
COPY blockchain/ ./
# compile at build time (downloads solc once) so a restart only redeploys
RUN npx hardhat compile
COPY deploy/chain-entrypoint.sh /usr/local/bin/chain-entrypoint.sh

EXPOSE 8545
HEALTHCHECK --interval=30s --timeout=2s --start-period=90s --start-interval=2s --retries=3 \
    CMD test -f /app/blockchain/deployments/localhost.json
ENTRYPOINT ["sh", "/usr/local/bin/chain-entrypoint.sh"]
