#!/usr/bin/env bash
# Container version of scripts/dev.sh: fresh node, deploy, keep the node in the foreground.
set -euo pipefail

rpc_up() {
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:8545
}

# the chain is fresh on every start, so any previous deployment file is stale
rm -f deployments/localhost.json

npx hardhat node --hostname 0.0.0.0 --port 8545 &
NODE_PID=$!
trap 'kill -TERM $NODE_PID 2>/dev/null' TERM INT

until rpc_up; do
  kill -0 $NODE_PID 2>/dev/null || { echo "hardhat node exited" >&2; exit 1; }
  sleep 0.5
done

npx hardhat run scripts/deploy-local.ts --network localhost
wait $NODE_PID
