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

// Phase rules, job setup and commit/reveal checks. Payouts are in Settlement.ts, stakes and
// reputation in Reputation.ts.
const PRICE = parseEther("1");
const EXECUTION_TIME = 60n;
const IMAGE = "repo@sha256:abc";

// Status enum indices in OffBalance.sol
const Status = {
	JOB_SUBMITTED: 0,
	COMMIT: 2,
	REVEAL: 3,
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

	// the reveal window lives in the contract; read it so the tests follow any retuning
	const windows = await viem.deployContract("OffBalance");
	const REVEAL_WINDOW = Number(await windows.read.REVEAL_WINDOW());

	async function deploy() {
		const contract = await viem.deployContract("OffBalance");
		return { contract };
	}

	// The contract's names: `k` = matching answers needed, `quorum` = providers assigned.
	async function submitted(k = 2n, quorum = 3n) {
		const { contract } = await networkHelpers.loadFixture(deploy);
		await contract.write.submitJob(
			[PRICE, k, quorum, EXECUTION_TIME, IMAGE],
			{ account: buyer.account, value: PRICE },
		);
		return contract;
	}

	async function assigned(k = 2n, quorum = 3n) {
		const contract = await submitted(k, quorum);
		await contract.write.assignProviders([
			1n,
			providers.slice(0, Number(quorum)).map((p) => p.account.address),
		]);
		return contract;
	}

	describe("submitJob", () => {
		it("assigns sequential job ids", async () => {
			const contract = await submitted();
			await viem.assertions.emitWithArgs(
				contract.write.submitJob(
					[PRICE, 2n, 3n, EXECUTION_TIME, IMAGE],
					{ account: buyer.account, value: PRICE },
				),
				contract,
				"JOB_SUBMITTED",
				[2n],
			);
		});

		it("rejects k above the quorum, zero k, and a wrong escrow", async () => {
			const { contract } = await networkHelpers.loadFixture(deploy);
			const submit = (k: bigint, value = PRICE) =>
				contract.write.submitJob(
					[PRICE, k, 3n, EXECUTION_TIME, IMAGE],
					{ account: buyer.account, value },
				);
			await viem.assertions.revertWith(
				submit(4n),
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
		it("requires exactly the quorum of providers, from the server", async () => {
			const contract = await submitted();
			await viem.assertions.revertWith(
				contract.write.assignProviders([
					1n,
					[p1.account.address, p2.account.address],
				]),
				"Must assign exact quorum",
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

	describe("getDeadlines", () => {
		it("reports each phase's chain-time deadline as the job moves", async () => {
			const contract = await assigned();
			const assignedAt = BigInt(await networkHelpers.time.latest());
			assert.deepEqual(await contract.read.getDeadlines([1n]), [
				Status.COMMIT, assignedAt + EXECUTION_TIME, 0n, 0n,
			]);

			await networkHelpers.time.increase(Number(EXECUTION_TIME) + 1);
			await contract.write.startRevealPhase([1n]);
			const revealedAt = BigInt(await networkHelpers.time.latest());
			const [status, , revealDeadline, deliveryDeadline] = await contract.read.getDeadlines([1n]);
			assert.equal(status, Status.REVEAL);
			assert.equal(revealDeadline, revealedAt + BigInt(REVEAL_WINDOW));
			assert.equal(deliveryDeadline, 0n);
		});
	});

	describe("commit and reveal", () => {
		it("only accepts one correctly staked commitment from assigned providers", async () => {
			const contract = await assigned();
			const STAKE = await contract.read.stakeFor([1n, p1.account.address]);
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
			const STAKE = await contract.read.stakeFor([1n, p1.account.address]);
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
});
