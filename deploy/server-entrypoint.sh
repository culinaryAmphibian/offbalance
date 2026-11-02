#!/bin/sh
# Like startup.py's start_server: a database for this chain run, the dev wallets seeded into it,
# a certificate, then the server.
#
# The database is named after the chain's genesis block hash, which is new on every chain start,
# so a restarted (empty) chain never meets jobs from the previous one. A watchdog restarts the
# server (Docker's restart policy brings it back) when the genesis changes underneath it, e.g.
# when Docker restarted a crashed chain container or the machine rebooted.
set -eu
cd /app/server
RPC="${RPC_URL:-http://chain:8545}"
DEPLOYMENT=/app/blockchain/deployments/localhost.json

rpc() {
  curl -sf -m 5 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC"
}
genesis() {
  rpc eth_getBlockByNumber '["0x0",false]' | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).result.hash.slice(2, 18)'
}

# wait for the contract on the live chain: the deployment file may be left over from the last run
until ADDRESS=$(node -p "require('$DEPLOYMENT').address" 2>/dev/null) \
    && rpc eth_getCode "[\"$ADDRESS\",\"latest\"]" | grep -q '"result":"0x[0-9a-fA-F][0-9a-fA-F]'; do
  echo "waiting for OffBalance on $RPC..."
  sleep 2
done

GENESIS=$(genesis)
export MONGODB_URI="${MONGO_URL:-mongodb://mongo:27017}/offbalance_${GENESIS}"
echo "database offbalance_${GENESIS} (chain genesis 0x${GENESIS}...)"

node scripts/dev-cert.ts
node seed.ts

node server.ts &
SERVER_PID=$!
trap 'kill -TERM $SERVER_PID 2>/dev/null; wait $SERVER_PID; exit 0' INT TERM
while kill -0 $SERVER_PID 2>/dev/null; do
  sleep 10 & wait $!
  NOW=$(genesis 2>/dev/null || true)
  if [ -n "$NOW" ] && [ "$NOW" != "$GENESIS" ]; then
    echo "the chain was restarted (genesis 0x${NOW}...); restarting on a fresh database"
    kill -TERM $SERVER_PID
    wait $SERVER_PID || true
    exit 1
  fi
done
wait $SERVER_PID
