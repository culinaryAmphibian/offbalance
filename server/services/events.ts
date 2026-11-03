// Keeps the database in step with contract events.
import { Types } from "mongoose";
import { formatEther } from "viem";
import { AccountModel, ChainEventModel, HardwareModel, JobModel, TERMINAL_STATUSES } from "../models/index.ts";
import { STATUS_FOR_EVENT } from "../models/JobStatus.ts";
import type { ChainEvent } from "./chain.ts";
import type { Matcher } from "./matcher.ts";

async function accountForAddress(address: unknown) {
	const hw = await HardwareModel.findOne({ address: String(address).toLowerCase() });
	return hw?.userRef ?? (await AccountModel.findOne({ walletIds: String(address).toLowerCase() }))?._id ?? null;
}

// SLASHED moves no money the database tracks; REPUTATION_UPDATED carries its reputation effect.
const IGNORED_EVENTS = new Set(["COMMITTED", "REVEALED", "CONSENSUS_REACHED", "STAKE_REFUNDED", "SLASHED"]);

export async function handleChainEvent(event: ChainEvent, matcher: Matcher): Promise<void> {
	if (event.id && await ChainEventModel.exists({ _id: event.id })) return;
	await applyChainEvent(event, matcher);
	if (event.id) await ChainEventModel.updateOne({ _id: event.id }, {}, { upsert: true });
}

async function applyChainEvent({ name, args, id }: ChainEvent, matcher: Matcher): Promise<void> {
	// Per-provider protocol steps; nothing in the database tracks them.
	if (IGNORED_EVENTS.has(name)) return;
	// The contract keeps the reputation (it sets stakes); the database copies the trust score, as a
	// fraction. Events arrive in chain order, so the latest wins. Needs no job in the database.
	if (name === "REPUTATION_UPDATED") {
		const account = await accountForAddress(args.provider);
		if (account) await AccountModel.updateOne({ _id: account }, { reputation: Number(args.trustBps) / 10_000 });
		return;
	}
	const jobId = Number(args.jobId);
	if (!Number.isSafeInteger(jobId) || jobId < 0) throw new TypeError("Invalid event jobId.");
	const effectId = id ?? `${jobId}:${name}:${String(args.provider ?? "").toLowerCase()}`;
	const job = await JobModel.findOne({ onChainJobId: jobId });
	if (!job) {
		console.warn(`${name}: job ${jobId} isn't in the database; ignoring`);
		return;
	}

	switch (name) {
		case "JOB_SUBMITTED":
			if (!job.submittedAt) {
				job.submittedAt = new Date();
				await job.save();
			}
			await matcher.ping();
			return;

		// the server's own assignment, read back from the chain
		case "PROVIDER_SELECTED": {
			const account = await accountForAddress(args.provider);
			if (!account) {
				console.warn(`PROVIDER_SELECTED: no account for ${args.provider}`);
				return;
			}
			await JobModel.updateOne({ _id: job._id }, { $addToSet: { providers: account } });
			await AccountModel.updateOne({ _id: account }, { $addToSet: { takenJobs: job._id } });
			return;
		}

		// the contract reports the provider's payout in wei; older events without it settle at the running price
		case "PAID": {
			const account = await accountForAddress(args.provider);
			if (account) {
				const earned = typeof args.amount === "bigint" ? Types.Decimal128.fromString(formatEther(args.amount)) : job.runningPrice;
				await AccountModel.updateOne(
					{ _id: account, processedChainEvents: { $ne: `${effectId}:provider` } },
					{ $inc: { totalEarned: earned }, $addToSet: { processedChainEvents: `${effectId}:provider` } },
				);
				// the job view's payment details; one payout per provider per job
				await JobModel.updateOne(
					{ _id: job._id, "payouts.provider": { $ne: account } },
					{ $push: { payouts: { provider: account, amount: earned } } },
				);
			}
			// the buyer is charged once per job, on DELIVERED, not once per provider payout
			return;
		}

		// The buyer escrowed job.maxPrice in submitJob; settlement spends exactly that escrow.
		// Keyed by job (not by log) so a replayed or duplicate DELIVERED never charges twice.
		case "DELIVERED": {
			const charge = `job:${job._id}:buyer-spent`;
			await AccountModel.updateOne(
				{ _id: job.owner, processedChainEvents: { $ne: charge } },
				{ $inc: { totalSpent: job.maxPrice }, $addToSet: { processedChainEvents: charge } },
			);
			break; // then the status update below
		}
	}

	const status = STATUS_FOR_EVENT[name];
	if (!status) {
		console.warn(`Unhandled contract event ${name}`);
		return;
	}
	job.status = status;
	if (TERMINAL_STATUSES.includes(status) && !job.settledAt) job.settledAt = new Date();
	await job.save();

	if (TERMINAL_STATUSES.includes(status)) {
		await AccountModel.updateOne({ _id: job.owner }, { $addToSet: { completedJobs: job._id } });
		matcher.release(job.onChainJobId);
		await matcher.ping(); // its providers are free again
	}
}
