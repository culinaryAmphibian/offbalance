# OffBalance testing plan

For the testing phase after Milestone 4. It covers what is tested today, how to run it, the bugs the tests have already found, and the tests we still need, ranked by priority. Nothing in Section 5 or later is written yet.

Status as of 2026-11-17, on the `test-coverage` branch (from `milestone4` `1b402b91`). Items marked ✅ in Section 5 are written and passing (or written as `todo`/expected-failure for a known bug).

---

## 1. Goals

1. **Correct money movement.** Every wei the contract takes in (escrow, stakes) ends up exactly where the rules say: winners, refunds, or slashed. Nothing gets stuck or paid twice.
2. **Correct consensus.** Honest providers who agree are paid; providers who disagree, don't commit or don't reveal are slashed; no-quorum refunds everyone.
3. **Consistent state.** The database, the UI and the provider client agree with the chain about every job's phase, providers and payouts.
4. **Safe execution.** Buyers' containers can't escape their limits, and malicious inputs (archives, images, requests) can't hurt the server or a provider.
5. **A working demo.** Several machines can run the whole flow on a real network.

---

## 2. Test levels and where they live

| Level | Component | Location | Runner | Needs |
|---|---|---|---|---|
| Unit | Smart contract | `blockchain/contracts/OffBalance.t.sol` | `cd blockchain && npx hardhat test` (Solidity tests) | Node |
| Unit | Provider client | `client/test/*.py` | `cd client && python -m unittest discover -s test` | Python venv; Docker and GPUs are mocked |
| Unit | Server | `server/test/` (managers, unit, storage) | `npm run test:managers`, `test:unit`, `test:storage` | Node |
| Integration | Server + database | `server/test/` (`test:db`) | `MONGODB_URI=… npm run test:db` | MongoDB |
| Integration | Server over HTTPS + Python client | `server/test/https-client.test.ts` | `npm run test:https` | MongoDB, OpenSSL, `TEST_PYTHON` |
| Contract test | Server ↔ client API shape | `server/test/client-contract.test.ts` | `npm run test:dev` (mock), `test:real` | — / MongoDB |
| End-to-end | Chain + server + database | `server/test/e2e-chain.test.ts` | `npm run test:e2e` | MongoDB, Hardhat |
| Unit | Frontend | `frontend/test/*.test.js` | `cd frontend && npm test` | Node |
| Component | Frontend React components | `frontend/test/components/*.spec.jsx` | `cd frontend && npm run test:components` (Vitest + jsdom) | Node |
| E2E (browser) | Frontend demo | `frontend/test/browser-smoke.cjs` | `npm run test:browser` | Playwright Chromium, demo Vite |
| E2E (browser) | Frontend + real server + real chain (wallet transactions) | `frontend/test/chain-browser.cjs` | `npm run test:chain-browser` | Playwright, MongoDB, `blockchain/` installed |
| Accessibility (browser) | Frontend demo, every page | `frontend/test/a11y-browser.cjs` | `npm run test:a11y` (demo Vite running) | Playwright, `axe-core` |
| E2E (browser) | Frontend + real server | `frontend/test/server-browser.cjs` | `npm run test:integration` | Playwright, MongoDB |
| System | Chain + HTTPS server + MongoDB + 3 real provider clients + real Docker | `server/test/system-full-stack.test.ts` | `npm run test:system` (about 8 min) | MongoDB, Docker, `TEST_PYTHON` with the client's requirements |
| System | `docker compose --profile host` + one provider container | `server/test/system/compose-smoke.ts` | see the file header (CI job `compose-smoke`) | Docker |
| Measurement | Contract gas per function | — | `cd blockchain && npm run test:gas` | Node |
| Coverage | Contract | — | `cd blockchain && npm run test:coverage` | Node |
| Static analysis | Contract | — | `slither blockchain/contracts/OffBalance.sol --compile-force-framework solc` (CI job `static-analysis`) | `pip install slither-analyzer solc-select`, solc 0.8.34 |
| System | Fault injection: chain RPC and MongoDB outages mid-job | `server/test/e2e-outages.test.ts` | part of `npm run test:e2e` | Docker |
| System | Soak: continuous jobs for an hour | `server/test/system/soak.ts` | `SOAK_MINUTES=60 npm run test:soak` | same as `test:system` |
| System | Everything, several machines | — | Manual checklist (Section 8) | Docker, a LAN, MetaMask |

**CI** (`.github/workflows/node.js.yml`) runs all of the automated rows above on every push and PR to `main` and `milestone4`, except the real-GPU benchmark test and the hour-long soak. The browser tests run in Chromium, Firefox and WebKit there (`BROWSER=firefox|webkit`).

**WebKit locally** needs system libraries that only `sudo` can install, once: `cd frontend && sudo npx playwright install-deps webkit`. Chromium and Firefox need nothing extra.

**Local runs on Windows.** The server's `test:dev` script and the `e2e` test need a POSIX shell, so run the server suites in WSL or Linux. MongoDB: `docker start offbalance-mongo` (port 27018), then `MONGODB_URI=mongodb://127.0.0.1:27018`.

---

## 3. Current status

| Suite | `milestone4` | On `test-coverage` (11/17) |
|---|---|---|
| Contract (Solidity) | 22 | 47, all pass (incl. 3 fuzz tests) |
| Provider client | 85 | 138: 131 pass, 1 skipped (real GPU), 6 expected failures (known bugs) |
| Frontend unit | 88 | 93: 92 pass, 1 todo (known bug) |
| Frontend components | — | 34: 33 pass, 1 expected failure (known bug) |
| Frontend browser | 5 demo + 6 real-server scenarios | unchanged (CI only) |
| Server | 218 | 300: 297 pass, 3 todo, 0 fail (snapshot after `fix/server-bugs`) |
| System (full stack, real clients + Docker) | — | 5 scenarios, all pass (about 8 min) |
| Compose smoke | — | 1 job end to end, passes |

Server line coverage: 89.6% on `milestone4`, 97.5% with the new branch. Coverage for the other components hasn't been measured (see Section 9).

**Branches to sort out before the testing phase:**
- `test-coverage`: every test in this plan (pushed). Needs review and a PR into `milestone4`; the new CI jobs (`system`, `compose-smoke`) only run on pushes and PRs to `main` and `milestone4`.
- `origin/codex/fix-contract-test-ci`: branched from 10/22 and deletes `blockchain/test/OffBalance.test.js`, which `milestone4` no longer has. Probably obsolete; check with whoever opened it, then close it.
- `feature/reputation-stake`: the price-weighted reputation design. Not merged; its tests target the old contract.

---

## 4. Known bugs found by tests

The table tracks bug status on `milestone5`. When fixing an open bug, remove its known-failure marker (`todo` in Node, `expectedFailure` in Python or `test.fails` in Vitest) so the regression test runs normally.

| # | Bug | Severity | Test | Fix |
|---|---|---|---|---|
| B1 | ✅ **Fixed in [#40](https://github.com/culinaryAmphibian/offbalance/pull/40).** **Database and contract job numbers drift apart.** The server numbers saved jobs itself; the contract numbers only submitted jobs, in submission order. Cancelling a job before submitting it, or submitting jobs out of order, makes the chain's events update the wrong job. | High | `job-ids.test.ts` (runs normally) | Link the saved quote to the actual contract job ID from the confirmed submission event. |
| B2 | ✅ **Fixed on `fix/server-bugs`.** **A docker command that exits early crashes the server** (`EPIPE`, no error handler on the child's stdin). Affects `login`, `push` and the `image rm` after every build. | High | `builds.test.ts` (runs normally) | One line in `docker()` in `services/builder.ts`: `child.stdin.on("error", () => {})`. |
| B3 | ✅ **Fixed on `fix/server-bugs`.** One account can list the same wallet twice. | Low | `mongo-db-audit.test.ts` (runs normally) | Validate unique `walletIds` within an account. |
| B4 | ✅ **Fixed on `fix/server-bugs`** (also stops an update lowering "providers" below "required matching results"). An update can raise "required matching results" above "providers". | Low | `mongo-db-audit.test.ts` (runs normally) | Fix the `minNodesToAgree` update validator. |
| B5 | ✅ **Fixed in [#39](https://github.com/culinaryAmphibian/offbalance/pull/39).** **Jobs stall after a server restart.** Phase timers live in memory and the monitor resumes from its checkpoint, so jobs that were mid-phase are never advanced. | High | `e2e-staking-restart.test.ts` (runs normally) | On startup, rebuild phase timers for unfinished jobs from current on-chain deadlines. |
| B8 | **A paid job looks unfinished in the UI.** The server's final status for a paid job is `PAYOUT`, which the frontend shows as "verifying — Payment is being processed". | Medium | `frontend/test/statuses.test.js` (todo) | Show `PAYOUT` as completed in `jobs.js`. |
| B9 | **Jobs have no process limit.** A buyer's container can fork-bomb the provider's machine (`pids.max` is `max`). | High | `test_docker_integration.py` (expected failure) | `pids_limit` in `RunManager`'s `containers.run`. |
| B10 | **Jobs can gain privileges** through setuid binaries in their image (`NoNewPrivs` is 0). | Medium | `test_docker_integration.py` (expected failure) | `security_opt=['no-new-privileges']` in `RunManager`. |
| B12 | ✅ **Fixed in [#39](https://github.com/culinaryAmphibian/offbalance/pull/39).** **A provider client restarted after committing can't reveal** (the committed result hash is only kept in memory), so the provider is slashed for a job it did. | High | `test_chain_integration.py` (runs normally) | Save the result and reveal salt before broadcasting the commitment so it can be revealed after a restart. |
| B13 | ✅ **Fixed in [#39](https://github.com/culinaryAmphibian/offbalance/pull/39).** **A provider client restarted after it was assigned never runs the job**: it watches the chain from the current block, so it never sees its `PROVIDER_SELECTED` again, and it's slashed. | High | `test_chain_integration.py` (runs normally) | Restore known assignments and resume active work from the provider journal and current chain phase. |
| B14 | ✅ **Fixed on `fix/server-bugs`.** **An expired sign-in nonce still works** for up to about a minute: the server relies on MongoDB's TTL cleanup instead of checking the nonce's age. | Low | `auth-hardening.test.ts` (runs normally) | Check `createdAt` against `NONCE_TTL_S` in `verifyWalletSignature`. |
| B15 | **`docker compose run host-client --dev` crashes**: `docker-compose.yml` passes `OFFBALANCE_API_KEY` as an empty string when it isn't configured, and `--dev` uses that instead of the dev key ("the API key is empty"). Only the interactive mode works. | Medium | `test_chain_and_dispatch.py` (expected failure); the CI smoke job works around it with `-e OFFBALANCE_API_KEY=dev` | Treat an empty variable as unset in `main.load_dev_credentials` (or drop the default in the compose file). |
| B16 | ✅ **Fixed in [#36](https://github.com/culinaryAmphibian/offbalance/pull/36).** **After submitting a job, its page never offers "Cancel"** until it's reloaded: the page hides cancel while its own transaction is in flight and never clears that state. Reloading signs the user out (the session lives only in memory), so they have to sign in again to cancel. | Low | `JobDetail.spec.jsx` and `chain-browser.cjs` (run normally) | Restore on-chain cancellation as soon as the coordinator records the submission. |
| B17 | ✅ **Fixed in [#36](https://github.com/culinaryAmphibian/offbalance/pull/36).** **"Collect funds" never confirms in the dev server (and so in the demo)**: the money is withdrawn, but the button stays on "Check your wallet…". The app runs in `<StrictMode>`, which mounts components twice in development, and `CollectFunds` only ever sets its `active` ref to `false`. | Medium (visible in the demo) | `CollectFunds.spec.jsx` and `chain-browser.cjs` (run normally) | Reset the mounted state on effect setup so the withdrawal confirmation and balance refresh work under React StrictMode. |
| B11 | **The client drops a job if a second assignment arrives before the first one runs** (the second manifest replaces the first), so the provider is slashed for the first. The server sends one job at a time, so this needs a server bug to trigger. | Low | `test_chain_and_dispatch.py` (expected failure) | Keep a manifest per job in `RunManager`. |

**Found by reading code:**
| # | Issue | Severity |
|---|---|---|
| B6 | **Tied consensus picks an arbitrary winner.** The contract accepts any split where the top answer has ≥ k matches; it doesn't require a majority. A 4-provider job needing 2 matches can split 2–2, and the first-revealed answer wins while the other pair is slashed. `OffBalanceEdges.t.sol` pins down today's behaviour until the team decides. | Medium (design decision) |
| B7 | ✅ **Fixed in [#40](https://github.com/culinaryAmphibian/offbalance/pull/40).** **Escrow and payout followed different pricing rules.** The wallet now funds the full booked window for all requested providers. Settlement pays eligible providers at their booked rates and refunds unused escrow. Verified by `OffBalancePricing.t.sol` and `system-full-stack.test.ts`. Requires the updated contract for new quoted jobs. | Medium |

**Load observation (not a bug at demo scale):** one matching pass over 2,000 providers and 500 queued jobs takes about 8 s, because every job re-sorts every provider and recomputes scores inside the sort, on the server's event loop (`load.test.ts`). A burst of 200 heartbeats with 40 waiting jobs settles in about 3 s against MongoDB. Worth fixing only if the marketplace grows: score each provider once per pass.

**Behaviour worth knowing (not a bug):** when a buyer cancels at the instant the matcher claims the job, the claim is correctly refused, but the rest of that matching pass is abandoned (logged as "Matching failed"), so other waiting jobs wait for the next trigger (at most about 10 s). `concurrency.test.ts` covers it.

---

## 5. New tests to write

Priorities: **P1** = before the final demo/submission; **P2** = during the testing phase; **P3** = if time allows. Owners follow the Milestone 4 roles (Gabe: frontend; Alex: database, hosting, contract; Sergey: client, server, contract; Felix: contract) and can be swapped.

### 5.1 Smart contract

| Pri | Test | Type | What it catches |
|---|---|---|---|
| ✅ P1 | **Solvency invariant (fuzz):** random sequences of submit / assign / stake / commit / reveal / cancel / finalize / settle / withdraw across several jobs; after every step, the contract balance equals buyers' escrows + locked stakes + credits + slashed-and-retained funds. | Fuzz / invariant (Foundry `invariant_` or `testFuzz_`) | Lost or double-paid wei in any path, including ones nobody thought to write a test for |
| ✅ P1 | Tie: 4 providers, k = 2, a 2–2 split. Pin down the intended behaviour first (B6). | Unit | Arbitrary winners; honest providers slashed |
| ✅ P1 | Settlement arithmetic: dust goes to exactly one winner; winners share the slashed pool; one winner; all winners; prices that don't divide evenly. | Unit / fuzz on price and counts | Rounding errors, stuck dust |
| ✅ P1 | `withdraw` re-entrancy: a receiving contract that calls `withdraw` again from its `receive()`. | Unit | Double withdrawal |
| ✅ P2 | Deadline boundaries: stake/commit/reveal at exactly the deadline and one second after; every phase function called too early and in the wrong phase. | Unit | Off-by-one deadline checks |
| ✅ P2 | Reputation limits: never below 0, never above 65535; `stakeFor` at 0, 999, 1000, 1001, 2000, 65535 matches the formula (including the interpolation between half-lives). | Unit / fuzz | Overflow, wrong curve |
| ✅ P2 | Session keys mid-job: a key that expires or is revoked between staking and revealing (the provider can't reveal and is slashed; funds still go to the owner); registering a new key mid-job. | Unit | Locked-out providers, misdirected funds |
| ✅ P2 | `registerSessionKey` funding to a key that rejects ETH (a contract) reverts the whole registration. | Unit | Half-registered keys |
| ✅ P2 | Cancel rules: buyer can cancel in `JOB_SUBMITTED` and `PROVIDER_SELECTED` only; non-buyers never; cancel after finalize reverts. | Unit | Cancelling running jobs |
| ✅ P2 | Gas report per job for 2, 3, 5 and 10 providers (settlement and finalize loops). | Measurement (`hardhat test --gas-stats` or a gas snapshot) | Gas growth; inputs for the gas-cost risk |
| ✅ P3 | Static analysis with Slither (Section 5.6; CI job `static-analysis`); fix or document every finding. | Static analysis | Common Solidity pitfalls |
| ✅ P3 | Contract coverage report (99.5% of lines, Section 5.6; (`hardhat test --coverage`), aiming for every branch. | Coverage | Untested branches |

### 5.2 Server and database

| Pri | Test | Type | What it catches |
|---|---|---|---|
| ✅ P1 | B1 and B2 regression tests run normally after their fixes. | Integration | Job ID drift and Docker build crashes |
| ✅ P1 | **Restart recovery (B5):** restart the coordinator after the commit phase is checkpointed and verify the job advances through payout. | Integration (e2e harness) | Stalled jobs after a restart |
| ✅ P1 | Chain e2e with the current contract's staking phase: a provider that never stakes is dropped; too few stakers → NO_QUORUM; the server finalizes early once everyone stakes. | E2E (`e2e-chain.test.ts`) | Orchestrator/staking regressions |
| ✅ P1 | Concurrency: a buyer cancels while the matcher claims the same job; two deliveries while the job moves to PAYOUT; many simultaneous `POST /jobs`. Assert exactly one winner each time. | Integration | Races in the status updates |
| ✅ P2 | Event monitor (already covered by `blockchain-manager.test.js`): a reorg stops the monitor; `CHAIN_CONFIRMATIONS > 0` holds events back; a gap in blocks after downtime is caught up from the checkpoint. | Integration | Missed or duplicated events |
| ✅ P2 | Matching properties: random providers and jobs; check no provider is double-booked, the buyer is never matched to their own job, every match fits the budget and hardware, and the ranking is stable. | Property-based (fast-check) | Edge cases in matching |
| ✅ P2 | Heartbeat and liveness under load (`load.test.ts`): 500 providers heartbeating every 10 s; matching latency stays small. | Load | Scheduler slowdowns |
| ✅ P2 | Auth hardening (`auth-hardening.test.ts`; token expiry still needs a team policy): tokens never expire today (decide on a policy and test it); nonce TTL index removes old nonces; requests with very long or odd headers. | Integration | Session abuse |
| ✅ P2 | Result archives (already covered by `result-archive.test.ts`): symlink and path-traversal entries, huge file counts, decompression-style bombs inside the 25 MiB limit. Several exist already; add file-count and depth limits. | Unit | Server disk/CPU exhaustion |
| ✅ P3 | Data migration (`data-migration.test.ts`): an old database (±1 reputation counters, records without hardware profiles) still loads and serializes. | Integration | Upgrade failures |
| ✅ P3 | MongoDB unavailable mid-request (`e2e-outages.test.ts`): routes answer 503 rather than hang or crash, and recover when it returns. | Integration | Outage behaviour |

### 5.3 Provider client

| Pri | Test | Type | What it catches |
|---|---|---|---|
| ✅ P1 | **Client against a real Hardhat node:** with a session key, stake → commit → reveal → withdraw by the owner, using the real ABI (today's tests mock the contract). | Integration | ABI drift; signing and nonce bugs |
| ✅ P1 | **Real Docker job:** run a small alpine job end to end; the output hash is identical across two runs and across machines (Linux, WSL, macOS if available). | Integration (Docker) | Non-determinism that breaks consensus |
| ✅ P1 | Container isolation with an adversarial image: no network, CPU/memory limits hold, can't write outside `/output`, killed at the deadline, no privileged mode, can't reach the Docker socket. | Integration (Docker) | Buyer code escaping onto the provider |
| ✅ P2 | Client restarted mid-job (B12, B13) (after staking, after committing): it recovers and reveals, or at least reports clearly what it can't recover. | Integration | Slashing after a crash |
| ✅ P2 | Session key runs out of ETH halfway (`test_credentials.py`, `test_chain_integration.py`): a clear error before staking, never a half-done commit. | Unit | Confusing failures |
| ✅ P2 | Two assignments arriving while one job runs; events from the same block in either order. | Unit | Concurrency bugs |
| P3 | Real GPU benchmark on an NVIDIA machine (`OFFBALANCE_GPU_TEST=1`); AMD if anyone has one. | Hardware | GPU detection on real drivers |

### 5.4 Frontend

| Pri | Test | Type | What it catches |
|---|---|---|---|
| ✅ P1 | **Browser test against a real chain** (`chain-browser.cjs`): verifies B16 by canceling on-chain without reloading and B17 by checking the withdrawal confirmation and updated balance. | E2E (Playwright) | Wallet-flow regressions |
| ✅ P1 | Job status view shows every server status correctly (PENDING through PAYOUT, CANCELED, NO_QUORUM) and refreshes within the 5 s poll. | Component (React Testing Library) or browser | Wrong or stuck status display |
| ✅ P2 | Component tests (`test/components/*.spec.jsx`, all five components): `JobForm` (validation, USD conversion, GPU fields), `JobDetail`, `ProviderSetup`, `SessionKeyPanel` (key shown once, revoke), `CollectFunds` (wrong account, nothing to collect). | Component | UI logic bugs |
| ✅ P2 | MetaMask errors (`wallet.test.js` and the component tests): user rejects, wrong network, chain restarted (nonce errors) all show a clear message. | Unit / browser | Unhelpful errors at the demo |
| ✅ P3 | Accessibility check (axe) on every page; keyboard-only navigation (`a11y-browser.cjs`: no WCAG 2.1 A/AA violations). | Automated a11y | Accessibility issues |
| ✅ P3 | Firefox and WebKit runs of the browser tests (`BROWSER=firefox|webkit`; all pass in Firefox; WebKit runs in CI). | E2E | Browser-specific bugs |

### 5.5 Whole system

| Pri | Test | Type | What it catches |
|---|---|---|---|
| ✅ P1 | **Full-stack scripted run** (`system-full-stack.test.ts`, all 5 scenarios pass) (`startup.py` or Docker host mode + 3 real provider clients + real Docker): <br>1. Happy path → PAID, result downloadable, credits correct.<br>2. One provider returns a different output → slashed, others paid.<br>3. One provider never stakes → dropped, job continues.<br>4. All disagree → NO_QUORUM refunds.<br>5. Buyer cancels during staking → refunds. | System (automated) | Integration bugs no single suite sees |
| ✅ P1 | Docker Compose smoke test in CI (`system/compose-smoke.ts`, CI job `compose-smoke`): start `--profile host`, run one `host-client`, run the happy path. | System (CI) | Broken images or compose config |
| ✅ P2 | Fault injection (`e2e-outages.test.ts` for chain and MongoDB outages): stop the server, chain or MongoDB at each phase and restart it; record what happens to the job and the money. Server restart (B5) and client restarts (B12, B13) are covered; chain and MongoDB outages aren't yet. | System | Recovery gaps (see B5) |
| ✅ P3 | Soak test (`soak.ts`, 11/17: 60 min, 51 jobs, 41 paid + 10 no-quorum as designed, 0 stuck, db lag max 0.5 s, server memory 167 → 181 MB, clients flat at 75 MB): jobs submitted continuously for an hour with 3–5 providers; watch memory, event lag and stuck jobs. | System | Leaks, slow drift |

---

## 5.6 Static analysis and coverage results (11/17)

**Contract coverage** (`npm run test:coverage`): 99.5% of lines, 99.3% of statements. The two uncovered lines can't run: the `==` operator for `JobID_t` is never used (dead code), and the settlement loop's "skip providers with no stake" check is unreachable because unstaked providers are removed when staking closes.

**Slither** (`slither-analyzer` 0.11.6, solc 0.8.34): 32 findings, none High.

| Severity | Finding | Count | Assessment |
|---|---|---|---|
| Medium | divide-before-multiply in `_payWinnersAndSlashLosers` | 1 | False positive: `share = pool / winners` then `dust = pool - share * winners` computes the remainder on purpose, and the dust goes to a winner. The fuzz tests confirm no wei is lost. |
| Low | `block.timestamp` comparisons | 13 | By design: every phase is a time window. Validators can shift timestamps by a few seconds, which matters most for the 15 s reveal window; on a real chain the windows should be longer. |
| Info | naming conventions | 14 | Upper-case event names, mixed-case functions. Cosmetic. |
| Info | low-level calls | 2 | `withdraw` and the session-key funding transfer; both check the result and update state first. |
| Info | dead code | 1 | The unused `==` operator (same as the coverage gap). |
| Info | solc version | 1 | `pragma ^0.8.20` floats; pin it for a real deployment. |

---

## 6. Test data and environments

| Environment | Use | Notes |
|---|---|---|
| Developer machine (Linux/WSL) | All automated suites | MongoDB in Docker on 27018; Hardhat dev chain with the public keys in `dev.env` |
| CI (GitHub Actions, Ubuntu 22.04) | All automated suites on every push/PR | MongoDB 8.0 service container; Playwright Chromium |
| Docker host + client machines on one LAN | Multi-machine system tests and the demo | `HOW_TO_RUN_WITH_DOCKER.md`; check the host IP every time; phone hotspot as backup |
| GPU machine | Real GPU benchmark | NVIDIA Container Toolkit |

**Test data rules.**
- Each database test creates and drops its own uniquely named database.
- Dev keys and API keys are public: never use them outside a local or trusted network.
- Fixed images by digest (e.g. `alpine@sha256:…`) for job tests, so results are reproducible.

---

## 7. Entry and exit criteria

**A change can merge when:**
- CI is green.
- New behaviour has a test.
- A bug fix comes with a test that failed before the fix.

**The testing phase is done when:**
- Every P1 test is written and passing, and every P2 test is written or explicitly deferred.
- B1, B2, B5 and B7 are fixed. B6 still needs a team decision.
- No test is skipped in CI except the real-GPU test.
- The multi-machine checklist (Section 8) passes twice in a row on the demo network.

---

## 8. Manual multi-machine checklist (demo rehearsal)

Run with one host and at least two provider machines.

| # | Step | Expected |
|---|---|---|
| 1 | Host: `HOST_ADDRESS` matches the current IP; `docker compose --profile host up --build` | All services healthy; certificate check shows the right IP |
| 2 | Each client: `--profile client run --rm client`; sign in; copy the API key; authorize a session key; paste both | Client benchmarks, appears online in Provider setup |
| 3 | Each provider sets an hourly price | Machine is matchable |
| 4 | Buyer submits a 2-of-2 or 2-of-3 job with a pinned image | Status moves through staking, commit, reveal, delivery to PAYOUT within about a minute plus the job's run time |
| 5 | Buyer downloads the result | Archive matches what the providers produced |
| 6 | Providers collect funds | Wallet balances rise by share + stake |
| 7 | Stop one client during staking on a new job | That provider is dropped; the job continues or ends in NO_QUORUM with refunds |
| 8 | Restart the host | Clients need new keys; MetaMask needs its activity data cleared; everything works again |

---

## 9. Coverage and reporting to add

| Component | How | Target |
|---|---|---|
| Server | `node --test --experimental-test-coverage` (already used) | Keep ≥ 95% lines once the new branch is merged |
| Contract | `npx hardhat test --coverage` | Every branch of settlement and session keys |
| Client | `coverage run -m unittest discover -s test` | Report first, then set a target |
| Frontend | `node --test --experimental-test-coverage` | Report first, then set a target |

Publish the coverage reports as CI artifacts so the team can see them per PR.

---

## 10. Mapping to the Milestone 4 test plan

| Milestone ID | Covered by |
|---|---|
| T1 Provider client | Section 3 client suite; new tests in 5.3 |
| T2 Smart contract | Contract suite; new tests in 5.1 (T2b "payout by hourly rate" depends on decision B7) |
| T3 Frontend | Frontend unit and browser suites; new tests in 5.4 |
| T4 Server | Server suites; new tests in 5.2 |
| T5 Database | `test:db` suites; B1, B3, B4; migration and outage tests in 5.2 |
| T6 Whole system e2e | `e2e-chain.test.ts`; full-stack run in 5.5 |
| T7 Multi-machine demo | Section 8 checklist |
