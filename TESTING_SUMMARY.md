# Testing summary: `test-coverage` branch

A short overview of the testing work so far and what's still needed for this stage. [TESTING_PLAN.md](TESTING_PLAN.md) has the full detail for each item.

## What's done

Every test in the testing plan is written and has been run, except the real-GPU benchmark (it needs GPU hardware).

**Test counts, `milestone4` → this branch**

| Area | Before | Now |
|---|---|---|
| Smart contract | 22 | 47, all pass. Includes fuzz tests; 99.5% line coverage |
| Server | 218 | 300. Line coverage 89.6% → 97.5% |
| Provider client | 85 | 138 |
| Frontend unit | 88 | 93 |
| Frontend components (new) | — | 34 |
| Full system: chain + server + 3 real provider clients + Docker (new) | — | 5 scenarios, all pass |

Every test either passes or is marked as a known failure for one of the bugs listed below. Nothing fails unexpectedly.

**What the new tests cover**
- **Contract:**
  - Money is never lost or double-paid. A fuzz test checks the contract's balance after every random sequence of actions.
  - Settlement rounding, re-entrancy, deadlines, reputation limits, session keys, cancel rules, gas costs.
  - Slither static analysis finds no High issues.
- **Server:**
  - Restart recovery and concurrent requests.
  - Matching rules, tested with random inputs.
  - Load: 500 providers.
  - Auth hardening and result-archive safety.
  - Loading an old (milestone3-shaped) database.
  - Chain and MongoDB outages mid-job: jobs still finish and are paid exactly once.
- **Provider client:**
  - Runs against a real Hardhat node and real Docker jobs.
  - Container isolation against a hostile job image.
  - Restarts in the middle of a job.
- **Frontend:**
  - Component tests for all five components.
  - Every job status shown correctly; MetaMask errors.
  - A browser test of the wallet flows against a real chain.
  - Accessibility: no WCAG 2.1 A/AA violations, and the app works with the keyboard alone.
  - Chrome, Firefox and WebKit.
- **Whole system:**
  - The full-stack scenarios: happy path, no consensus, a cheater gets slashed, a no-show gets dropped, the buyer cancels.
  - A Docker Compose smoke test.
  - A 60-minute soak test. Results:
    - 51 jobs: 41 paid and 10 no-quorum, as designed. None stuck.
    - The database stays within 0.5 s of the chain.
    - No memory leak.

**New in CI** (runs on PRs to `main` and `milestone4`): the system tests, the Compose smoke test, the component tests, the real-chain browser test, Firefox and WebKit runs, the accessibility check, and a Slither job.

## What still needs doing

### 1. Review and merge this branch
Review `test-coverage` and open a PR into `milestone4`.

### 2. Bug status
Fixed bugs are marked below. When fixing an open bug, remove its known-failure marker (`todo` in Node, `expectedFailure` in Python or `test.fails` in Vitest) so the test runs normally. Section 4 of the plan has the test and fix details.

**High priority**

| # | Bug | Where |
|---|---|---|
| B1 | The server's and the contract's job IDs drift apart after a job is canceled before submission, or after jobs are submitted out of order. Chain events then update the wrong job. ✅ **Fixed in [#40](https://github.com/culinaryAmphibian/offbalance/pull/40).** | server |
| B2 | A docker command that exits early crashes the server (`EPIPE`). ✅ Fixed on `fix/server-bugs`. | server |
| B5 | Jobs stall after a server restart, because the phase timers aren't restored. ✅ **Fixed in [#39](https://github.com/culinaryAmphibian/offbalance/pull/39).** | server |
| B9 | A job has no process limit, so it can fork-bomb the provider's machine. | client |
| B12 | A provider restarted after committing can't reveal, so it gets slashed. ✅ **Fixed in [#39](https://github.com/culinaryAmphibian/offbalance/pull/39).** | client |
| B13 | A provider restarted after being assigned never runs the job, so it gets slashed. ✅ **Fixed in [#39](https://github.com/culinaryAmphibian/offbalance/pull/39).** | client |

**Medium priority**

| # | Bug | Where |
|---|---|---|
| B17 | "Collect funds" never confirms in the dev server, and so in the demo, even though the money is withdrawn. ✅ **Fixed in [#36](https://github.com/culinaryAmphibian/offbalance/pull/36).** | frontend |
| B7 | Wallet escrow and settlement disagreed with the hourly rate. New quoted jobs fund the booked window, pay the booked rates and refund unused escrow on the updated contract. ✅ **Fixed in [#40](https://github.com/culinaryAmphibian/offbalance/pull/40).** | contract, server, frontend |
| B8 | A paid job shows as "Payment is being processed" instead of completed. | frontend |
| B10 | A job can gain privileges through setuid binaries. | client |
| B15 | `docker compose run host-client --dev` crashes; only interactive mode works. | client/compose |

**Low priority:**
- B3: duplicate wallets on one account. ✅ Fixed on `fix/server-bugs`.
- B4: a validator lets "required matches" exceed "providers". ✅ Fixed.
- B11: a second assignment can overwrite the first.
- B14: an expired sign-in nonce still works for about a minute. ✅ Fixed.
- B16: "Cancel" is hidden after submitting until the page is reloaded. ✅ **Fixed in [#36](https://github.com/culinaryAmphibian/offbalance/pull/36).**

### 3. Team decisions needed
- **B6, tied consensus:** a 2–2 split currently picks whichever answer was revealed first, and the other pair is slashed. Should the contract require a majority?   
- **Token expiry:** sign-in tokens never expire. We need to agree on a policy before we can test one.

### 4. Remaining tests
- **Real-GPU benchmark:** needs a machine with an NVIDIA GPU.
- **The manual multi-machine demo rehearsal checklist:** in Section 8 of the plan.

### 5. Housekeeping
- `origin/codex/fix-contract-test-ci` looks obsolete. Check with whoever opened it, then close it.
- `feature/reputation-stake` is unmerged, and its tests target the old contract.

## Running the tests
These need Linux (WSL works), Docker and MongoDB. The commands for each suite are in Section 2 of the plan.

The common ones:
```bash
cd blockchain && npm test                                # contract (npm run test:coverage for a report)
cd server && npm test                                    # server unit, integration, e2e (needs MONGODB_URI)
cd server && npm run test:system                         # full stack, about 8 min
cd frontend && npm test && npm run test:components
cd client && .venv/bin/python -m unittest discover -s test
```

Running WebKit locally needs one extra setup step: `cd frontend && sudo npx playwright install-deps webkit`
