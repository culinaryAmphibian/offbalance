// Reputation-scaled stakes: settlement updates each provider's value-weighted record, and the
// record sets the stake on the provider's next assignment.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeAbiParameters, keccak256, parseEther, toHex, type Hex } from "viem";

const PRICE = parseEther("0.01");
const EXECUTION_TIME = 60n;
const IMAGE = "repo@sha256:abc";
const BPS = 10_000n;
const PRIOR = parseEther("0.01");

const salt = (n: number): Hex => toHex(n, { size: 32 });
const commitment = (output: Hex, s: Hex): Hex =>
	keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(output), s]));

// the contract's formulas, for exact expected values
const trust = (earned: bigint, strikes: bigint) => (earned + PRIOR) * BPS / (earned + strikes + 2n * PRIOR);
function multiplier(earned: bigint, strikes: bigint, price: bigint) {
	const t = trust(earned, strikes);
	if (t < 5_000n) return BPS + 20_000n * (5_000n - t) / 5_000n;
	let discount = 5_000n * (t - 5_000n) / 5_000n;
	if (earned < price) discount = discount * earned / price;
	return BPS - discount;
}
const stake = (earned: bigint, strikes: bigint, price: bigint, quorum: bigint) =>
	price * 1_000n * multiplier(earned, strikes, price) / (BPS * BPS * quorum);

describe("OffBalance reputation", async function () {
	const { viem, networkHelpers } = await network.create();
	const [, buyer, p1, p2, p3] = await viem.getWalletClients();
	const providers = [p1, p2, p3];

	async function deploy() {
		return viem.deployContract("OffBalance");
	}

	type Contract = Awaited<ReturnType<typeof deploy>>;
	let nextJob = 1n;

	async function submit(contract: Contract, price: bigint, quorum = 3n, executionTime = EXECUTION_TIME) {
		await contract.write.submitJob([price, 2n, quorum, executionTime, IMAGE], { account: buyer.account, value: price });
		return nextJob++;
	}

	// Runs an assigned job to settlement. outputs[i] is provider i's answer: null never commits,
	// "hide" commits but never reveals.
	async function finish(contract: Contract, jobId: bigint, outputs: (Hex | null | "hide")[]) {
		for (const [i, output] of outputs.entries()) {
			if (!output) continue;
			const value = await contract.read.stakeFor([jobId, providers[i].account.address]);
			await contract.write.submitCommitment([jobId, commitment(output === "hide" ? "0x00" : output, salt(i))], { account: providers[i].account, value });
		}
		await networkHelpers.time.increase(Number(EXECUTION_TIME) + 1);
		await contract.write.startRevealPhase([jobId]);
		for (const [i, output] of outputs.entries()) {
			if (output && output !== "hide") await contract.write.submitReveal([jobId, output, salt(i)], { account: providers[i].account });
		}
		await networkHelpers.time.increase(Number(await contract.read.REVEAL_WINDOW()) + 1);
		await contract.write.endRevealPhase([jobId]);
		if (await contract.read.getJobStatus([jobId]) === 5) { // DELIVERING
			await networkHelpers.time.increase(Number(await contract.read.DELIVERY_WINDOW()) + 1);
			await contract.write.endDeliveryPhase([jobId]);
		}
	}

	async function run(contract: Contract, outputs: (Hex | null | "hide")[], price = PRICE) {
		const jobId = await submit(contract, price, BigInt(outputs.length));
		await contract.write.assignProviders([jobId, providers.slice(0, outputs.length).map(p => p.account.address)]);
		await finish(contract, jobId, outputs);
		return jobId;
	}

	async function fresh() {
		nextJob = 1n;
		return networkHelpers.loadFixture(deploy);
	}

	const record = async (contract: Contract, who: typeof p1) => contract.read.reputation([who.account.address]);

	it("a new provider is at 50% trust and stakes 10% of its share of the price", async () => {
		const contract = await fresh();
		assert.deepEqual(await contract.read.reputationOf([p1.account.address]), [0n, 0n, 5_000n, BPS]);
		const jobId = await submit(contract, PRICE);
		assert.equal(await contract.read.stakeFor([jobId, p1.account.address]), PRICE / 30n);
		assert.equal(await contract.read.stakeQuote([p1.account.address, PRICE, 3n]), PRICE / 30n);
	});

	it("agreeing with the consensus earns the payout as reputation and lowers the next stake", async () => {
		const contract = await fresh();
		await run(contract, ["0xaa", "0xaa", "0xaa"]);
		const share = PRICE / 3n;
		for (const p of providers) assert.deepEqual(await record(contract, p), [share, 0n]);
		const events = await contract.getEvents.REPUTATION_UPDATED({}, { fromBlock: 0n });
		assert.equal(events.length, 3);
		assert.equal(events[0].args.trustBps, trust(share, 0n));

		// next job: the discount is scaled by earned/price, since only a third of the price was earned
		const next = await submit(contract, PRICE);
		const expected = stake(share, 0n, PRICE, 3n);
		assert.equal(await contract.read.stakeFor([next, p1.account.address]), expected);
		assert.ok(expected < PRICE / 30n);
	});

	it("weights strikes by price: 3x for a rejected answer, 2x for no reveal, 1x for no commit", async () => {
		const contract = await fresh();
		await run(contract, ["0xaa", "0xaa", "0xbb"]);
		assert.deepEqual(await record(contract, p3), [0n, PRICE * 3n / 3n]);

		const contract2 = await fresh();
		await run(contract2, ["0xaa", "0xaa", "hide"]);
		assert.deepEqual(await record(contract2, p3), [0n, PRICE * 2n / 3n]);

		const contract3 = await fresh();
		await run(contract3, ["0xaa", "0xaa", null]);
		assert.deepEqual(await record(contract3, p3), [0n, PRICE / 3n]);
	});

	it("a strike also takes the same amount off earned reputation", async () => {
		const contract = await fresh();
		await run(contract, ["0xaa", "0xaa", "0xaa"], parseEther("0.03")); // each earns 0.01
		await run(contract, ["0xaa", "0xbb", "0xbb"]);                     // p1 is rejected: strike 0.01
		assert.deepEqual(await record(contract, p1), [0n, PRICE]);
		const [, , t] = await contract.read.reputationOf([p1.account.address]);
		assert.ok(t < 5_000n, "below a new provider");
	});

	it("an untrusted provider stakes up to 3x, and the stake rises with every failure", async () => {
		const contract = await fresh();
		await run(contract, ["0xaa", "0xaa", "0xbb"]);
		const once = await contract.read.stakeQuote([p3.account.address, PRICE, 3n]);
		assert.equal(once, stake(0n, PRICE, PRICE, 3n));
		assert.ok(once > PRICE / 30n);
		await run(contract, ["0xaa", "0xaa", "0xbb"]);
		const twice = await contract.read.stakeQuote([p3.account.address, PRICE, 3n]);
		assert.ok(twice > once);
		assert.ok(twice <= PRICE * 3n / 30n);
	});

	it("no quorum leaves revealing providers' reputation alone but strikes missing commits", async () => {
		const contract = await fresh();
		await run(contract, ["0xaa", "0xbb", null]);
		assert.equal(await contract.read.getJobStatus([1n]), 9); // NO_QUORUM
		assert.deepEqual(await record(contract, p1), [0n, 0n]);
		assert.deepEqual(await record(contract, p2), [0n, 0n]);
		assert.deepEqual(await record(contract, p3), [0n, PRICE / 3n]);
	});

	it("the full discount needs delivered value of at least the job's price", async () => {
		const contract = await fresh();
		// ten cheap jobs: plenty of trust, but little value delivered
		for (let i = 0; i < 10; i++) await run(contract, ["0xaa", "0xaa", "0xaa"], parseEther("0.003"));
		const [earned, strikes] = await record(contract, p1);
		assert.equal(earned, parseEther("0.01"));
		const big = parseEther("1");
		assert.equal(await contract.read.stakeMultiplierBps([p1.account.address, big]), multiplier(earned, strikes, big));
		assert.ok(await contract.read.stakeMultiplierBps([p1.account.address, big]) > 9_900n, "almost no discount on a 1 ETH job");
		assert.equal(await contract.read.stakeMultiplierBps([p1.account.address, earned]), multiplier(earned, strikes, earned));
		assert.ok(await contract.read.stakeMultiplierBps([p1.account.address, earned]) < 9_000n, "a real discount on a cheap job");
	});

	it("fixes each stake at assignment, so settling another job doesn't change it", async () => {
		const contract = await fresh();
		const first = await submit(contract, PRICE);
		const second = await submit(contract, PRICE, 3n, 3_600n); // still committing after the first settles
		await contract.write.assignProviders([first, providers.map(p => p.account.address)]);
		await contract.write.assignProviders([second, providers.map(p => p.account.address)]);
		const fixed = await contract.read.stakeFor([second, p3.account.address]);
		await finish(contract, first, ["0xaa", "0xaa", "0xbb"]); // p3 is struck
		assert.equal(await contract.read.stakeFor([second, p3.account.address]), fixed);
		await viem.assertions.revertWith(
			contract.write.submitCommitment([second, commitment("0xaa", salt(9))], { account: p3.account, value: fixed + 1n }),
			"Incorrect stake",
		);
		await contract.write.submitCommitment([second, commitment("0xaa", salt(9))], { account: p3.account, value: fixed });
	});

	it("stakes at least 1 wei on a tiny job, and rejects quotes for unknown jobs", async () => {
		const contract = await fresh();
		assert.equal(await contract.read.stakeQuote([p1.account.address, 5n, 3n]), 1n);
		await viem.assertions.revertWith(contract.read.stakeFor([99n, p1.account.address]), "Unknown job");
	});
});
