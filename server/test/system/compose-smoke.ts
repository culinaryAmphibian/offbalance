// Smoke test for `docker compose --profile host`: one job, start to finish, through the
// containerized chain, server, MongoDB and a containerized provider client. Run it on the host
// machine once the stack and one provider are up:
//
//   docker compose --profile host up -d --build --wait mongo blockchain server
//   docker compose --profile host run -d --rm -e OFFBALANCE_API_KEY=dev host-client --dev --provider 1
//     (-e: compose passes an empty OFFBALANCE_API_KEY otherwise, which --dev uses; TESTING_PLAN.md B15)
//   docker compose --profile host cp server:/app/server/.local/tls/cert.pem /tmp/offbalance-cert.pem
//   CA_FILE=/tmp/offbalance-cert.pem node server/test/system/compose-smoke.ts
//
// API_URL and RPC_URL default to the host's published ports. Exits non-zero on any failure.
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { Stack, Status, until } from "./driver.ts";

const apiUrl = process.env.API_URL ?? "https://localhost:5000";
const rpcUrl = process.env.RPC_URL ?? "http://localhost:8545";
const caFile = process.env.CA_FILE;
if (!caFile) throw new Error("set CA_FILE to the server's certificate (docker compose cp server:/app/server/.local/tls/cert.pem ...)");

const step = (message: string) => console.log(`[smoke] ${message}`);

step(`connecting to ${apiUrl} and ${rpcUrl}`);
const stack = await until("the server", () => Stack.connect({ apiUrl, rpcUrl, caFile }), 120_000);
step(`contract ${stack.address}`);

step("waiting for provider 1 (the host-client container) to benchmark and come online");
await stack.waitForOnline("dev", 300_000);
await stack.setPrice("dev", 0.001);

const provider = stack.env.PROVIDER_1_ADDRESS as `0x${string}`;
const before = await stack.credits(provider);
const id = await stack.submitJob({ name: "compose smoke", command: ["sh", "-c", "echo 'compose smoke' > /output/result.txt"],
	providers: 1, agree: 1, window: 60, maxPrice: "0.01" });
step(`job ${id} submitted; waiting for staking, commit, reveal, delivery and payout`);
await stack.waitForStatus(id, [Status.PAID], 300_000);

const stake = await stack.requiredStake(id, provider);
assert.equal(await stack.credits(provider) - before, parseEther("0.001") / 60n + 1n + stake, "the provider is paid its rounded booked charge plus its stake back");
const files = await stack.download(id);
assert.equal(files.get("result.txt"), "compose smoke\n", "the buyer downloads what the provider's container wrote");
const job = await until("the server to record the payout", async () => { const j = await stack.job(id); return j.status === "PAYOUT" && j; }, 30_000);
assert.equal(job.result.available, true);
step(`job ${id} paid and its result downloaded: the compose stack works end to end`);
