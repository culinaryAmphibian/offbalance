import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
	encodeAbiParameters,
	keccak256,
	parseEther,
	toHex,
	type Hex,
} from "viem";

const PRICE = parseEther("1");
const STAKE = parseEther("0.0001");
const EXECUTION_TIME = 60n;
const REVEAL_WINDOW = 120;
const DELIVERY_WINDOW = 300;
const IMAGE = "repo@sha256:abc";

// Status enum indices in OffBalance.sol
const Status = {
	JOB_SUBMITTED: 0,
	DELIVERING: 5,
	PAID: 7,
	CANCELED: 8,
	NO_QUORUM: 9,
} as const;

const salt = (n: number): Hex => toHex(n, { size: 32 });
const commitment = (output: Hex, s: Hex): Hex =>
	keccak256(
		encodeAbiParameters(
			[{ type: "bytes32" }, { type: "bytes32" }],
			[keccak256(output), s],
		),
	);

describe("OffBalance", async function () {
	const { viem, networkHelpers } = await network.create();
	const [server, buyer, p1, p2, p3, outsider] = await viem.getWalletClients();
	const providers = [p1, p2, p3];

	async function deploy() {
		const contract = await viem.deployContract("OffBalance");
		return { contract };
	}

	async function submitted(jobId = 1n, k = 3n, quorum = 2n) {
		const { contract } = await networkHelpers.loadFixture(deploy);
		await contract.write.submitJob(
			[jobId, PRICE, k, quorum, EXECUTION_TIME, IMAGE],
			{ account: buyer.account, value: PRICE },
		);
		return contract;
	}

	async function assigned(jobId = 1n, k = 3n, quorum = 2n) {
		const contract = await submitted(jobId, k, quorum);
		await contract.write.assignProviders([
			jobId,
			providers.slice(0, Number(k)).map((p) => p.account.address),
		]);
		return contract;
	}

	// Commit `outputs[i]` for provider i, move to reveal and reveal everyone that committed.
	async function revealed(outputs: Hex[], quorum = 2n) {
		const contract = await assigned(1n, BigInt(outputs.length), quorum);
		for (const [i, output] of outputs.entries()) {
			await contract.write.submitCommitment(
				[1n, commitment(output, salt(i))],
				{ account: providers[i].account, value: STAKE },
			);
		}
		await networkHelpers.time.increase(Number(EXECUTION_TIME) + 1);
		await contract.write.startRevealPhase([1n]);
		for (const [i, output] of outputs.entries()) {
			await contract.write.submitReveal([1n, output, salt(i)], {
				account: providers[i].account,
			});
		}
		await networkHelpers.time.increase(REVEAL_WINDOW + 1);
		return contract;
	}

	async function credits(contract: Awaited<ReturnType<typeof submitted>>) {
		return Promise.all(
			[buyer, p1, p2, p3].map((w) =>
				contract.read.credits([w.account.address]),
			),
		);
	}

	describe("submitJob", () => {
		it("rejects a reused job id", async () => {
			const contract = await submitted();
			await viem.assertions.revertWith(
				contract.write.submitJob(
					[1n, PRICE, 3n, 2n, EXECUTION_TIME, IMAGE],
					{ account: buyer.account, value: PRICE },
				),
				"Job id already used",
			);
		});

		it("rejects quorum above k, zero quorum, and a wrong escrow", async () => {
			const { contract } = await networkHelpers.loadFixture(deploy);
			const submit = (quorum: bigint, value = PRICE) =>
				contract.write.submitJob(
					[1n, PRICE, 2n, quorum, EXECUTION_TIME, IMAGE],
					{ account: buyer.account, value },
				);
			await viem.assertions.revertWith(
				submit(3n),
				"Invalid consensus threshold",
			);
			await viem.assertions.revertWith(
				submit(0n),
				"Invalid consensus threshold",
			);
			await viem.assertions.revertWith(
				submit(2n, PRICE - 1n),
				"Send exact job price",
			);
		});

		it("lets the buyer cancel before assignment and refunds the price", async () => {
			const contract = await submitted();
			await contract.write.cancelJob([1n], { account: buyer.account });
			assert.equal(
				await contract.read.getJobStatus([1n]),
				Status.CANCELED,
			);
			assert.equal(
				await contract.read.credits([buyer.account.address]),
				PRICE,
			);
		});
	});

	describe("assignProviders", () => {
		it("requires exactly k providers, from the server", async () => {
			const contract = await submitted();
			await viem.assertions.revertWith(
				contract.write.assignProviders([
					1n,
					[p1.account.address, p2.account.address],
				]),
				"Must assign exactly k providers",
			);
			await viem.assertions.revertWith(
				contract.write.assignProviders(
					[1n, providers.map((p) => p.account.address)],
					{ account: outsider.account },
				),
				"Only server",
			);
			await viem.assertions.emitWithArgs(
				contract.write.assignProviders([
					1n,
					providers.map((p) => p.account.address),
				]),
				contract,
				"COMMIT_PHASE_START",
				[1n, EXECUTION_TIME],
			);
		});
	});

	describe("commit and reveal", () => {
		it("only accepts one correctly staked commitment from assigned providers", async () => {
			const contract = await assigned();
			const c = commitment("0xaa", salt(0));
			await viem.assertions.revertWith(
				contract.write.submitCommitment([1n, c], {
					account: outsider.account,
					value: STAKE,
				}),
				"Provider not assigned",
			);
			await viem.assertions.revertWith(
				contract.write.submitCommitment([1n, c], {
					account: p1.account,
					value: STAKE - 1n,
				}),
				"Incorrect stake",
			);
			await contract.write.submitCommitment([1n, c], {
				account: p1.account,
				value: STAKE,
			});
			await viem.assertions.revertWith(
				contract.write.submitCommitment([1n, c], {
					account: p1.account,
					value: STAKE,
				}),
				"Already committed",
			);
		});

		it("rejects reveals that don't match, repeat, or have no commitment", async () => {
			const contract = await assigned();
			await contract.write.submitCommitment(
				[1n, commitment("0xaa", salt(0))],
				{ account: p1.account, value: STAKE },
			);
			await viem.assertions.revertWith(
				contract.write.startRevealPhase([1n]),
				"Commit phase not ended",
			);
			await networkHelpers.time.increase(Number(EXECUTION_TIME) + 1);
			await contract.write.startRevealPhase([1n]);

			await viem.assertions.revertWith(
				contract.write.submitReveal([1n, "0xbb", salt(0)], {
					account: p1.account,
				}),
				"Reveal does not match commitment",
			);
			await contract.write.submitReveal([1n, "0xaa", salt(0)], {
				account: p1.account,
			});
			await viem.assertions.revertWith(
				contract.write.submitReveal([1n, "0xaa", salt(0)], {
					account: p1.account,
				}),
				"Already revealed",
			);
			await viem.assertions.revertWith(
				contract.write.submitReveal([1n, "0xaa", salt(1)], {
					account: p2.account,
				}),
				"No commitment",
			);
		});
	});

	describe("settlement", () => {
		async function deliver(
			contract: Awaited<ReturnType<typeof submitted>>,
			who: typeof providers,
		) {
			await contract.write.endRevealPhase([1n]);
			assert.equal(
				await contract.read.getJobStatus([1n]),
				Status.DELIVERING,
			);
			for (const p of who)
				await contract.write.verifyReceipt([1n, p.account.address]);
			await networkHelpers.time.increase(DELIVERY_WINDOW + 1);
			await contract.write.endDeliveryPhase([1n]);
		}

		it("splits the price among providers that agreed and delivered", async () => {
			const contract = await revealed(["0xaa", "0xaa", "0xaa"]);
			await deliver(contract, providers);
			const share = PRICE / 3n;
			const dust = PRICE - share * 3n;
			assert.deepEqual(await credits(contract), [
				0n,
				share + dust + STAKE,
				share + STAKE,
				share + STAKE,
			]);
			assert.equal(await contract.read.getJobStatus([1n]), Status.PAID);
		});

		it("slashes a disagreeing provider and gives its stake to the winners", async () => {
			const contract = await revealed(["0xaa", "0xaa", "0xbb"]);
			await viem.assertions.revertWith(
				(async () => {
					await contract.write.endRevealPhase([1n]);
					return contract.write.verifyReceipt([
						1n,
						p3.account.address,
					]);
				})(),
				"Provider did not agree with consensus",
			);
			for (const p of [p1, p2])
				await contract.write.verifyReceipt([1n, p.account.address]);
			await networkHelpers.time.increase(DELIVERY_WINDOW + 1);
			await viem.assertions.emitWithArgs(
				contract.write.endDeliveryPhase([1n]),
				contract,
				"SLASHED",
				[1n, p3.account.address, STAKE],
			);
			const share = (PRICE + STAKE) / 2n;
			assert.deepEqual(await credits(contract), [
				0n,
				share + STAKE,
				share + STAKE,
				0n,
			]);
		});

		it("treats an agreeing provider that didn't deliver as a loser", async () => {
			const contract = await revealed(["0xaa", "0xaa", "0xaa"]);
			await deliver(contract, [p1, p2]);
			const share = (PRICE + STAKE) / 2n;
			assert.deepEqual(await credits(contract), [
				0n,
				share + STAKE,
				share + STAKE,
				0n,
			]);
		});

		it("refunds the buyer when nobody delivered", async () => {
			const contract = await revealed(["0xaa", "0xaa", "0xaa"]);
			await deliver(contract, []);
			assert.deepEqual(await credits(contract), [PRICE, 0n, 0n, 0n]);
		});

		it("without a quorum pays the providers that revealed and gives the buyer nothing", async () => {
			const contract = await revealed(["0xaa", "0xbb", "0xcc"], 2n);
			await viem.assertions.emit(
				contract.write.endRevealPhase([1n]),
				contract,
				"NO_QUORUM",
			);
			assert.equal(
				await contract.read.getJobStatus([1n]),
				Status.NO_QUORUM,
			);
			const share = PRICE / 3n;
			const dust = PRICE - share * 3n;
			assert.deepEqual(await credits(contract), [
				0n,
				share + dust + STAKE,
				share + STAKE,
				share + STAKE,
			]);
		});

		it("pays out credits through withdraw", async () => {
			const contract = await revealed(["0xaa", "0xaa", "0xaa"]);
			await deliver(contract, providers);
			const owed = await contract.read.credits([p2.account.address]);
			await viem.assertions.balancesHaveChanged(
				contract.write.withdraw({ account: p2.account }),
				[{ address: p2.account.address, amount: owed }],
			);
			await viem.assertions.revertWith(
				contract.write.withdraw({ account: p2.account }),
				"No credit",
			);
		});
	});
});
