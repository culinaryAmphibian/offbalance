#!/usr/bin/env bash
# Starts a fresh local chain, deploys OffBalance, then keeps the node in the
# foreground. Ctrl+C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

rpc_up() {
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    http://127.0.0.1:8545
}

# Deploying onto an already-running node shifts the contract addresses away
# from the ones in dev.env, so refuse instead.
if rpc_up; then
  echo "Something is already listening on 127.0.0.1:8545. Stop it first (e.g. the other 'hardhat node')." >&2
  exit 1
fi

npx hardhat node &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null' EXIT

until rpc_up; do
  kill -0 $NODE_PID 2>/dev/null || { echo "hardhat node exited" >&2; exit 1; }
  sleep 0.5
done

npx hardhat run scripts/deploy-local.ts --network localhost
wait $NODE_PID
