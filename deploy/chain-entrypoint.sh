#!/bin/sh
# Fresh chain on every start, like blockchain/scripts/dev.sh: start the node, deploy OffBalance
# (same address every time, see dev.env), then keep the node in the foreground.
#
# deployments/ is a volume shared with the server. localhost.json is removed first and written by
# the deploy, so the healthcheck only passes once this run's contract exists.
set -eu
cd /app/blockchain
rm -f deployments/localhost.json

rpc_up() {
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:8545
}

# 0.0.0.0 inside the container; docker-compose.yml publishes it on the host's 127.0.0.1 only
npx hardhat node --hostname 0.0.0.0 --port 8545 &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null' INT TERM

until rpc_up; do
  kill -0 $NODE_PID 2>/dev/null || { echo "hardhat node exited" >&2; exit 1; }
  sleep 0.5
done

npx hardhat run scripts/deploy-local.ts --network localhost
wait $NODE_PID
