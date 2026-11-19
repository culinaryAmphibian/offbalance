#!/usr/bin/env bash
# Run OffBalance's automated test suites (see TESTING_PLAN.md, Section 2) and print a summary.
#
#   ./test-all.sh                     contract, client, frontend, server
#   ./test-all.sh --system            ...plus the full-stack system test (~8 min, needs Docker)
#   ./test-all.sh --browser           ...plus the Playwright browser tests that need no demo server
#   ./test-all.sh --only client,server
#   ./test-all.sh --fail-fast
#
# Suites: contract, client, frontend, server, system, browser.
# MongoDB: uses MONGODB_URI if set, else one already listening on 127.0.0.1:27018 (MONGO_PORT).
# Otherwise it starts a throwaway mongo:8.2 container of its own on a random port, removed on exit;
# no other run can pick that one up, so overlapping runs can't pull the database from each other.
# Python: TEST_PYTHON if set, otherwise client/.venv/bin/python, otherwise python3.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONGO_PORT="${MONGO_PORT:-27018}"
MONGO_CONTAINER="offbalance-test-mongo-$$"
MONGO_IMAGE=mongo:8.2

suites=(contract client frontend server)
fail_fast=0
while (($#)); do
  case "$1" in
    --system) suites+=(system) ;;
    --browser) suites+=(browser) ;;
    --only) IFS=, read -ra suites <<<"${2:?--only needs a comma-separated list}"; shift ;;
    --fail-fast) fail_fast=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if [[ -t 1 ]]; then bold=$'\e[1m' green=$'\e[32m' red=$'\e[31m' reset=$'\e[0m'; else bold='' green='' red='' reset=''; fi
results=()
failed=0
started_mongo=0

cleanup() {
  if ((started_mongo)); then
    echo "Stopping $MONGO_CONTAINER"
    docker stop "$MONGO_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wants() { local s; for s in "${suites[@]}"; do [[ $s == "$1" ]] && return 0; done; return 1; }

# Install a package's dependencies when they're missing (or a needed binary isn't there).
ensure_npm() { # dir [binary]
  local dir="$ROOT/$1"
  if [[ ! -d $dir/node_modules || ( -n ${2:-} && ! -x $dir/node_modules/.bin/$2 ) ]]; then
    echo "Installing dependencies in $1/"
    (cd "$dir" && npm ci --no-audit --no-fund) || return 1
  fi
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

ensure_mongo() {
  if [[ -n ${MONGODB_URI:-} ]]; then return 0; fi
  if port_open "$MONGO_PORT"; then
    echo "Using the MongoDB already listening on port $MONGO_PORT (left running)"
    export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT"
    return 0
  fi
  command -v docker >/dev/null || { echo "MongoDB isn't running on $MONGO_PORT and Docker isn't installed" >&2; return 1; }
  docker run -d --rm --name "$MONGO_CONTAINER" -p "127.0.0.1::27017" "$MONGO_IMAGE" >/dev/null || return 1
  started_mongo=1
  local port
  port=$(docker port "$MONGO_CONTAINER" 27017/tcp | head -1 | sed 's/.*://') || return 1
  echo "Started $MONGO_CONTAINER ($MONGO_IMAGE) on port $port"
  export MONGODB_URI="mongodb://127.0.0.1:$port"
  for _ in $(seq 60); do port_open "$port" && return 0; sleep 0.5; done
  echo "MongoDB didn't start listening on port $port" >&2
  return 1
}

if [[ -z ${TEST_PYTHON:-} ]]; then
  if [[ -x $ROOT/client/.venv/bin/python ]]; then TEST_PYTHON="$ROOT/client/.venv/bin/python"; else TEST_PYTHON=python3; fi
fi
export TEST_PYTHON

# run NAME DIR COMMAND...: run one suite, record its result and duration.
run() {
  local name=$1 dir=$2; shift 2
  echo
  echo "${bold}━━━ $name ━━━${reset}  (cd ${dir#"$ROOT"/}; $*)"
  local start=$SECONDS status
  (cd "$dir" && "$@")
  status=$?
  local took=$((SECONDS - start))
  if ((status == 0)); then
    results+=("${green}PASS${reset}  $name (${took}s)")
  else
    results+=("${red}FAIL${reset}  $name (${took}s, exit $status)")
    failed=1
    if ((fail_fast)); then exit 1; fi
  fi
}

skip() { results+=("${red}FAIL${reset}  $1 (setup: $2)"); failed=1; if ((fail_fast)); then exit 1; fi; }

if wants contract; then
  if ensure_npm blockchain hardhat; then run "contract" "$ROOT/blockchain" npx hardhat test
  else skip contract "npm ci failed"; fi
fi

if wants client; then
  run "client" "$ROOT/client" "$TEST_PYTHON" -m unittest discover -s test
fi

if wants frontend; then
  if ensure_npm frontend vitest; then
    run "frontend unit" "$ROOT/frontend" npm test --silent
    run "frontend components" "$ROOT/frontend" npm run test:components --silent
  else skip frontend "npm ci failed"; fi
fi

if wants server || wants system; then
  ensure_npm server || skip server "npm ci failed"
  ensure_npm blockchain hardhat || skip server "blockchain npm ci failed"
  ensure_mongo || skip "server" "MongoDB unavailable"
fi

if wants server && [[ -n ${MONGODB_URI:-} ]]; then
  run "server" "$ROOT/server" npm test --silent
fi

if wants system && [[ -n ${MONGODB_URI:-} ]]; then
  run "system (full stack)" "$ROOT/server" npm run test:system --silent
fi

if wants browser; then
  if ensure_npm frontend playwright; then
    run "browser: chain + server" "$ROOT/frontend" npm run test:chain-browser --silent
    run "browser: real server" "$ROOT/frontend" npm run test:integration --silent
  else skip browser "npm ci failed"; fi
fi

echo
echo "${bold}━━━ Summary ━━━${reset}"
printf '%s\n' "${results[@]}"
exit $failed
