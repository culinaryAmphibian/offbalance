// System test: the whole stack as people run it, nothing mocked.
//   a Hardhat node + the real OffBalance, the real HTTPS server (server.ts) on MongoDB, and
//   three real provider clients (client/main.py --dev --provider 1..3) running real Docker jobs.
// The test is the buyer (HTTPS API + wallet, like the frontend) and, from scenario 3 on, a
// scripted fourth provider that misbehaves on purpose (see system/driver.ts).
//
//   1. happy path: 3 real providers agree -> PAID, the buyer downloads the result
//   2. no consensus: every provider's output is random -> NO_QUORUM, everyone refunded
//   3. a cheater: the scripted provider commits a made-up answer -> slashed, the others paid
//   4. a no-show: the scripted provider never stakes -> dropped after the 30 s window, job goes on
//   5. the buyer cancels while a no-show keeps staking open -> everyone refunded
//
// Takes about 8 minutes. Needs MONGODB_URI, a Docker daemon, blockchain/ installed, and a Python
// with the client's requirements (TEST_PYTHON, default python3). Skipped when any is missing.
//   MONGODB_URI=mongodb://127.0.0.1:27017 TEST_PYTHON=../client/.venv/bin/python npm run test:system
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Address } from "viem";
import { ScriptedProvider, Stack, Status, until } from "./system/driver.ts";
import { missingRequirements, startLocalStack, type LocalStack } from "./system/local-stack.ts";

const PRICE = "0.01"; // maximum ETH per provider-hour
const WINDOW = 30;    // seconds each provider gets to run the job
const JOB_TIMEOUT = 300_000;
const booked = (rate: string) => (parseEther(rate) * BigInt(WINDOW) + 3599n) / 3600n;
const ESCROW = 3n * booked(PRICE);
const PROVIDER_CHARGE = booked("0.001");

describe("full stack with real provider clients and Docker", { skip: missingRequirements(), timeout: 900_000 }, () => {
	let local: LocalStack;
	let stack: Stack;
	let scripted: ScriptedProvider;
	let real: { token: string; address: Address }[];

	// on failure, the end of every component's log says what happened
	async function scenario(fn: () => Promise<void>) {
		try { await fn(); }
		catch (error) {
			console.error(local?.logTails());
			throw error;
		}
	}

	before(async () => {
		local = await startLocalStack({ providers: 3 });
		stack = local.stack;
		real = local.providers;
		scripted = new ScriptedProvider(stack);
	});

	after(async () => {
		scripted?.stop();
		await local?.stop();
		if (local) console.log(`system test logs: ${local.logs}`);
	});

	const balances = (addresses: Address[]) => Promise.all(addresses.map(a => stack.credits(a)));
	const reputations = (addresses: Address[]) => Promise.all(addresses.map(a => stack.read<number>("reputationOf", [a])));
	const assigned = async (jobId: number) => (await stack.read<Address[]>("getAssignedProviders", [stack.contractId(jobId)])).map(a => a.toLowerCase());

	test("1. three real providers agree: the job is paid and the buyer downloads the result", () => scenario(async () => {
		const addresses = real.map(p => p.address);
		const [before, repBefore] = [await balances([stack.buyer.account!.address, ...addresses]), await reputations(addresses)];
		const draft = await stack.api("POST", "/jobs", { body: {
			name: "discarded draft", image: "alpine:3.20", maxPrice: PRICE, minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: WINDOW,
		} });
		assert.equal(draft.status, 201);
		assert.equal((await stack.api("POST", `/jobs/${draft.body.job.id}/cancel`)).status, 200);
		const id = await stack.submitJob({ name: "happy path", command: ["sh", "-c", "echo 'result from the happy path' > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.PAID], JOB_TIMEOUT);

		const stakes = await Promise.all(addresses.map(a => stack.requiredStake(id, a)));
		const after = await balances([stack.buyer.account!.address, ...addresses]);
		assert.notEqual(stack.contractId(id), BigInt(id), "the discarded draft shifts only the browser ID");
		assert.equal(after[0] - before[0], ESCROW - 3n * PROVIDER_CHARGE, "the buyer gets unused escrow back");
		for (const [i, stake] of stakes.entries()) {
			assert.equal(after[i + 1] - before[i + 1], PROVIDER_CHARGE + stake, `provider ${i + 1} gets their booked charge and stake`);
		}
		assert.deepEqual(await reputations(addresses), repBefore.map(r => r + 1), "everyone gains reputation");

		const files = await stack.download(id);
		assert.equal(files.get("result.txt"), "result from the happy path\n");
		const job = await until("the server to record the payout", async () => { const j = await stack.job(id); return j.status === "PAYOUT" && j; }, 30_000);
		assert.equal(job.result.available, true);
		assert.equal(parseEther(job.totalEscrow), ESCROW);
		assert.equal(parseEther(job.spent), 3n * PROVIDER_CHARGE);
		assert.equal(parseEther(job.payment.buyerRefund), ESCROW - 3n * PROVIDER_CHARGE);
		const dashboard = await stack.api("GET", "/account/me/dashboard");
		assert.equal(parseEther(dashboard.body.buyer.totalSpent), 3n * PROVIDER_CHARGE);
		for (const provider of real) {
			const providerDashboard = await stack.api("GET", "/account/me/dashboard", { token: provider.token });
			assert.equal(parseEther(providerDashboard.body.provider.totalEarned), PROVIDER_CHARGE);
		}
	}));

	test("2. every provider's output differs: no consensus, buyer and stakes refunded", () => scenario(async () => {
		const addresses = real.map(p => p.address);
		const before = await balances([stack.buyer.account!.address, ...addresses]);
		const repBefore = await reputations(addresses);
		const id = await stack.submitJob({ name: "random output", command: ["sh", "-c", "head -c 16 /dev/urandom | od -An -tx1 > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.NO_QUORUM], JOB_TIMEOUT);
		const stakes = await Promise.all(addresses.map(a => stack.requiredStake(id, a)));
		const after = await balances([stack.buyer.account!.address, ...addresses]);
		assert.equal(after[0] - before[0], ESCROW, "the buyer gets the price back");
		for (const [i, stake] of stakes.entries()) assert.equal(after[i + 1] - before[i + 1], stake, `provider ${i + 1} gets its stake back`);
		assert.deepEqual(await reputations(addresses), repBefore, "nobody's reputation changes");
		assert.equal((await stack.api("GET", `/jobs/${id}/result`)).status, 404, "there's no result to download");
		await until("the server to record no quorum", async () => (await stack.job(id)).status === "NO_QUORUM", 30_000);
	}));

	test("3. a provider commits a made-up answer: it's slashed and the honest two are paid", () => scenario(async () => {
		// the scripted provider undercuts the real ones, so it's always picked
		await scripted.start("cheat", 0.0005);
		await stack.waitForOnline("dev4", 30_000);
		const id = await stack.submitJob({ name: "with a cheater", command: ["sh", "-c", "echo honest > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.COMMIT], JOB_TIMEOUT);
		const chosen = await assigned(id);
		assert.ok(chosen.includes(scripted.address.toLowerCase()), "the cheater was assigned");
		const honest = real.filter(p => chosen.includes(p.address.toLowerCase())).map(p => p.address);
		assert.equal(honest.length, 2);
		const everyone = [scripted.address, ...honest];
		const before = await balances(everyone);
		const cheaterStake = await stack.requiredStake(id, scripted.address);

		await stack.waitForStatus(id, [Status.PAID], JOB_TIMEOUT);
		const after = await balances(everyone);
		assert.equal(after[0], before[0], "the cheater gets nothing back");
		const pool = 2n * PROVIDER_CHARGE + cheaterStake;
		const honestGained = (after[1] - before[1]) + (after[2] - before[2]);
		const honestStakes = (await stack.requiredStake(id, honest[0])) + (await stack.requiredStake(id, honest[1]));
		assert.equal(honestGained, pool + honestStakes, "the honest providers earn their work rate and share the cheater's stake");
		assert.equal(await stack.read<number>("reputationOf", [scripted.address]), 0);
		assert.equal((await stack.download(id)).get("result.txt"), "honest\n");
	}));

	test("4. a provider never stakes: it's dropped when staking closes and the job goes on", () => scenario(async () => {
		scripted.behaviour = "no-show";
		const id = await stack.submitJob({ name: "with a no-show", command: ["sh", "-c", "echo still done > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.PROVIDER_SELECTED], 60_000);
		const pending = (await stack.read<readonly bigint[]>("getDeadlines", [stack.contractId(id)]))[1];
		assert.ok((await assigned(id)).includes(scripted.address.toLowerCase()), "the no-show was assigned");
		const before = await stack.credits(scripted.address);

		await stack.waitForStatus(id, [Status.COMMIT], 120_000);
		assert.ok((await stack.rpc.getBlock()).timestamp > pending, "staking stayed open for the full window");
		const kept = await assigned(id);
		assert.ok(!kept.includes(scripted.address.toLowerCase()), "the no-show was dropped");
		assert.equal(kept.length, 2);
		await stack.waitForStatus(id, [Status.PAID], JOB_TIMEOUT);
		assert.equal(await stack.credits(scripted.address), before, "a no-show has nothing to lose or gain");
		assert.equal((await stack.download(id)).get("result.txt"), "still done\n");
	}));

	test("5. the buyer cancels while staking is still open: everyone is refunded", () => scenario(async () => {
		scripted.behaviour = "no-show"; // keeps staking open for 30 s
		const buyer = stack.buyer.account!.address;
		const id = await stack.submitJob({ name: "canceled", command: ["sh", "-c", "echo never > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.PROVIDER_SELECTED], 60_000);
		const chosen = await assigned(id);
		const staking = real.map(p => p.address).filter(a => chosen.includes(a.toLowerCase()));
		// wait until the real providers have staked, then cancel before the window closes
		await until("the real providers' stakes", async () => {
			const staked = await Promise.all(staking.map(a => stack.read<readonly unknown[]>("getProviderCommitment", [stack.contractId(id), a]).then(c => c[5] as bigint)));
			return staked.every(s => s > 0n);
		}, 25_000);
		const before = await balances([buyer, ...staking]);
		const stakes = await Promise.all(staking.map(a => stack.requiredStake(id, a)));
		await stack.cancelOnChain(id);
		assert.equal(await stack.status(id), Status.CANCELED);
		const after = await balances([buyer, ...staking]);
		assert.equal(after[0] - before[0], ESCROW, "the buyer gets the price back");
		for (const [i, stake] of stakes.entries()) assert.equal(after[i + 1] - before[i + 1], stake, "stakes come back");
		await until("the server to record the cancellation", async () => (await stack.job(id)).status === "CANCELED", 30_000);
	}));
});
