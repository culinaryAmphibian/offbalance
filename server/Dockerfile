# OffBalance HTTPS API.
#   docker build -t offbalance-server server
#   docker run --rm -p 5000:5000 \
#     -e MONGODB_URI=mongodb://host.docker.internal:27017/offbalance \
#     -v "$PWD/dev.env:/app/dev.env:ro" \
#     -v offbalance-deployments:/app/blockchain/deployments:ro \
#     offbalance-server
# Needs ../dev.env (mounted at /app/dev.env) for SEED=1, and the blockchain's
# deployments/localhost.json unless CHAIN=off.
FROM node:24-slim

# openssl: `npm run cert:dev` generates the development certificate
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY package.json package-lock.json ./
# Node runs the .ts sources directly (type stripping); typescript is only for typechecking
RUN npm ci --omit=dev

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV PORT=5000 \
    HOST=0.0.0.0 \
    RPC_URL=http://blockchain:8545 \
    DEPLOYMENT_FILE=/app/blockchain/deployments/localhost.json \
    MONGODB_URI=mongodb://mongo:27017/offbalance \
    SEED=1

EXPOSE 5000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "start"]
