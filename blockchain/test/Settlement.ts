// Settlement against the current OffBalance: winners get their share plus their stake back
// as credits, losers are slashed, and withdraw() sends the credits to the provider's wallet.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeAbiParameters, keccak256, parseEther, toHex, type Hex } from "viem";

const PRICE = parseEther("0.01");
const EXECUTION_TIME = 60n;
const IMAGE = "repo@sha256:abc";

const salt = (n: number): Hex => toHex(n, { size: 32 });
const commitment = (output: Hex, s: Hex): Hex =>
	keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(output), s]));

describe("OffBalance settlement", async function () {
	const { viem, networkHelpers } = await network.create();
	const publicClient = await viem.getPublicClient();
	const [, buyer, p1, p2, p3] = await viem.getWalletClients();
	const providers = [p1, p2, p3];

	async function deploy() {
		return viem.deployContract("OffBalance");
	}

	// The contract's names: `k` = matching answers needed, `quorum` = providers assigned.
	// outputs[i] is provider i's answer; null means it never commits.
	async function settled(outputs: (Hex | null)[], k = 2n) {
		const contract = await networkHelpers.loadFixture(deploy);
		const REVEAL_WINDOW = Number(await contract.read.REVEAL_WINDOW());
		const DELIVERY_WINDOW = Number(await contract.read.DELIVERY_WINDOW());
		await contract.write.submitJob([PRICE, k, BigInt(outputs.length), EXECUTION_TIME, IMAGE], { account: buyer.account, value: PRICE });
		const jobId = 1n;
		await contract.write.assignProviders([jobId, providers.slice(0, outputs.length).map(p => p.account.address)]);
		// every provider is new, so each stakes the base: 10% of its share of the price
		const STAKE = await contract.read.stakeFor([jobId, p1.account.address]);
		assert.equal(STAKE, PRICE / 10n / BigInt(outputs.length));
		for (const [i, output] of outputs.entries()) {
			if (output) await contract.write.submitCommitment([jobId, commitment(output, salt(i))], { account: providers[i].account, value: STAKE });
		}
		// while the job runs, each committed provider's stake shows as locked
		for (const [i, output] of outputs.entries()) {
			assert.equal(await contract.read.lockedStake([providers[i].account.address]), output ? STAKE : 0n);
		}
		await networkHelpers.time.increase(Number(EXECUTION_TIME) + 1);
		await contract.write.startRevealPhase([jobId]);
		for (const [i, output] of outputs.entries()) {
			if (output) await contract.write.submitReveal([jobId, output, salt(i)], { account: providers[i].account });
		}
		await networkHelpers.time.increase(REVEAL_WINDOW + 1);
		await contract.write.endRevealPhase([jobId]);
		if (await contract.read.getJobStatus([jobId]) === 5) { // DELIVERING
			await networkHelpers.time.increase(DELIVERY_WINDOW + 1);
			await contract.write.endDeliveryPhase([jobId]);
		}
		// settlement releases every stake, whether it was returned or slashed
		for (const p of providers) assert.equal(await contract.read.lockedStake([p.account.address]), 0n);
		const credits = await Promise.all([buyer, p1, p2, p3].map(w => contract.read.credits([w.account.address])));
		return { contract, STAKE, credits };
	}

	it("returns winners' stakes with their share and slashes the disagreeing provider", async () => {
		const { contract, STAKE, credits } = await settled(["0xaa", "0xaa", "0xbb"]);
		assert.deepEqual(credits, [0n, PRICE / 2n + STAKE, PRICE / 2n + STAKE, 0n]);
		const [, , , , , p3Stake] = await contract.read.getProviderCommitment([1n, p3.account.address]);
		assert.equal(p3Stake, 0n);
		// the contract still holds every credit owed, plus the slashed stake
		const owed = credits.reduce((a, b) => a + b, 0n);
		assert.equal(await publicClient.getBalance({ address: contract.address }) - owed, STAKE);
	});

	it("a provider that never committed gets nothing back", async () => {
		const { STAKE, credits } = await settled(["0xaa", "0xaa", null]);
		assert.deepEqual(credits, [0n, PRICE / 2n + STAKE, PRICE / 2n + STAKE, 0n]);
	});

	it("without a quorum refunds the buyer and every provider's stake", async () => {
		const { contract, STAKE, credits } = await settled(["0xaa", "0xbb", "0xcc"]);
		assert.equal(await contract.read.getJobStatus([1n]), 9); // NO_QUORUM
		assert.deepEqual(credits, [PRICE, STAKE, STAKE, STAKE]);
		// nothing is left behind in the contract
		assert.equal(await publicClient.getBalance({ address: contract.address }), PRICE + 3n * STAKE);
		const events = await contract.getEvents.STAKE_REFUNDED({}, { fromBlock: 0n });
		assert.equal(events.length, 3);
		assert.equal((await contract.getEvents.SLASHED({}, { fromBlock: 0n })).length, 0);
	});

	it("without a quorum a provider that never committed gets nothing", async () => {
		const { STAKE, credits } = await settled(["0xaa", "0xbb", null]);
		assert.deepEqual(credits, [PRICE, STAKE, STAKE, 0n]);
	});

	it("withdraw sends the credits (share + stake) to the provider's wallet", async () => {
		const { contract, STAKE } = await settled(["0xaa", "0xaa", "0xbb"]);
		const owed = PRICE / 2n + STAKE;
		const before = await publicClient.getBalance({ address: p1.account.address });
		const hash = await contract.write.withdraw({ account: p1.account });
		const receipt = await publicClient.waitForTransactionReceipt({ hash });
		const gas = receipt.gasUsed * receipt.effectiveGasPrice;
		const after = await publicClient.getBalance({ address: p1.account.address });
		assert.equal(after - before + gas, owed);
		assert.equal(await contract.read.credits([p1.account.address]), 0n);
		await viem.assertions.revertWith(contract.write.withdraw({ account: p1.account }), "No credit");
	});
});
