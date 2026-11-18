// Keeps the database in step with contract events.
import { Types } from "mongoose";
import { formatEther } from "viem";
import { AccountModel, ChainEventModel, HardwareModel, JobModel, TERMINAL_STATUSES } from "../models/index.ts";
import { JobStatus, STATUS_FOR_EVENT } from "../models/JobStatus.ts";
import type { ChainEvent } from "./chain.ts";
import type { Matcher } from "./matcher.ts";
import { findContractJob, type Job } from "../models/Job.ts";
import { pricingQuote } from "../pricing.ts";

async function accountForAddress(address: unknown, job: Job) {
	const wallet = String(address).toLowerCase();
	if (job.quoteId) return job.assignedRates.find(rate => rate.wallet === wallet)?.provider ?? null;
	const hw = await HardwareModel.findOne({ address: wallet });
	return hw?.userRef ?? (await AccountModel.findOne({ walletIds: wallet }))?._id ?? null;
}

const IGNORED_EVENTS = new Set([
	"COMMITTED", "REVEALED", "CONSENSUS_REACHED", "STAKE_REFUNDED",
	// staking phase: per-provider deposits and the finalized set; the status follows from the phase events
	"STAKED", "PROVIDERS_SELECTED",
	// account-level, not about a job (no jobId): a provider authorizing or revoking its client's key
	"SESSION_KEY_REGISTERED", "SESSION_KEY_REVOKED",
]);

export async function handleChainEvent(event: ChainEvent, matcher: Matcher): Promise<void> {
	if (event.id && await ChainEventModel.exists({ _id: event.id })) return;
	await applyChainEvent(event, matcher);
	if (event.id) await ChainEventModel.updateOne({ _id: event.id }, {}, { upsert: true });
}

async function applyChainEvent({ name, args, id }: ChainEvent, matcher: Matcher): Promise<void> {
	// Per-provider protocol steps; nothing in the database tracks them.
	if (IGNORED_EVENTS.has(name)) return;
	const jobId = Number(args.jobId);
	if (!Number.isSafeInteger(jobId) || jobId < 0) throw new TypeError("Invalid event jobId.");
	const effectId = id ?? `${jobId}:${name}:${String(args.provider ?? "").toLowerCase()}`;
	if (name === "QUOTED_JOB_SUBMITTED") {
		const quote = await JobModel.findOne({ quoteId: String(args.quoteId), buyerWallet: String(args.buyer).toLowerCase() });
		if (!quote) return;
		const { hourlyRateWei, escrowWei } = pricingQuote(quote);
		const matches = args.price === escrowWei && args.maxHourlyRate === hourlyRateWei
			&& args.k === BigInt(quote.minNodesToAgree) && args.quorum === BigInt(quote.minNodesToRunOn)
			&& args.executionTime === BigInt(quote.timeWindow) && args.dockerName === quote.dockerImageDigest;
		// Keep the actual id on a mismatch so the buyer can cancel and reclaim the deposit.
		await JobModel.updateOne({ _id: quote._id, contractJobId: null }, { $set: {
			contractJobId: jobId, submittedAt: new Date(),
			...(matches ? {} : { fundingError: "The funded job differs from the saved quote. Cancel it to reclaim the escrow." }),
		} });
		if (matches) await matcher.ping();
		return;
	}
	const job = name === "JOB_SUBMITTED"
		? await JobModel.findOne({ onChainJobId: jobId, quoteId: null })
		: await findContractJob(jobId);
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
			const account = await accountForAddress(args.provider, job);
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
			const account = await accountForAddress(args.provider, job);
			if (account) {
				const earned = typeof args.amount === "bigint" ? Types.Decimal128.fromString(formatEther(args.amount)) : job.runningPrice;
				await AccountModel.updateOne(
					{ _id: account, processedChainEvents: { $ne: `${effectId}:provider` } },
					{ $inc: { reputation: 1, totalEarned: earned }, $addToSet: { processedChainEvents: `${effectId}:provider` } },
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
			if (job.quoteId) return; // quoted jobs settle after the per-provider payout events
			const charge = `job:${job._id}:buyer-spent`;
			await AccountModel.updateOne(
				{ _id: job.owner, processedChainEvents: { $ne: charge } },
				{ $inc: { totalSpent: job.maxPrice }, $addToSet: { processedChainEvents: charge } },
			);
			break; // then the status update below
		}

		case "WORK_SETTLED": {
			if (!job.quoteId || typeof args.charged !== "bigint" || typeof args.refund !== "bigint"
				|| args.charged + args.refund !== pricingQuote(job).escrowWei) {
				throw new TypeError("Settlement does not reconcile with the saved quote.");
			}
			const charge = `job:${job._id}:buyer-spent`;
			job.workCharged = Types.Decimal128.fromString(formatEther(args.charged));
			job.buyerRefund = Types.Decimal128.fromString(formatEther(args.refund));
			await AccountModel.updateOne(
				{ _id: job.owner, processedChainEvents: { $ne: charge } },
				{ $inc: { totalSpent: job.workCharged }, $addToSet: { processedChainEvents: charge } },
			);
			break;
		}

		case "SLASH_REWARD": {
			const account = await accountForAddress(args.provider, job);
			if (!account || typeof args.amount !== "bigint") return;
			await JobModel.updateOne(
				{ _id: job._id, "payouts.provider": account },
				{ $set: { "payouts.$.slashReward": Types.Decimal128.fromString(formatEther(args.amount)) } },
			);
			return;
		}

		case "SLASHED": {
			const account = await accountForAddress(args.provider, job);
			if (account) await AccountModel.updateOne({ _id: account, processedChainEvents: { $ne: effectId } }, { $inc: { reputation: -1 }, $addToSet: { processedChainEvents: effectId } });
			return;
		}
	}

	const status = name === "WORK_SETTLED" ? JobStatus.PAYOUT : STATUS_FOR_EVENT[name];
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
