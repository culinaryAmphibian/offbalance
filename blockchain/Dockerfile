# Local Hardhat chain with OffBalance deployed.
#   docker build -t offbalance-blockchain blockchain
#   docker run --rm -p 8545:8545 -v offbalance-deployments:/app/blockchain/deployments offbalance-blockchain
# On start it launches a fresh `hardhat node` on 0.0.0.0:8545, deploys the
# contract and writes deployments/localhost.json (share that dir with server/client).
FROM node:24-slim

# git: the forge-std dependency is fetched from GitHub; curl: RPC readiness probe
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/blockchain
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# compile at build time so the solc download and artifacts are baked into the image
RUN npx hardhat compile

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8545
VOLUME ["/app/blockchain/deployments"]
# healthy once the contract is deployed (the entrypoint deletes stale output first)
HEALTHCHECK --interval=2s --timeout=3s --start-period=10s --retries=60 \
  CMD test -f /app/blockchain/deployments/localhost.json
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
