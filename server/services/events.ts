// Keeps the database in step with contract events.
import { Types } from "mongoose";
import { formatEther } from "viem";
import { AccountModel, ChainEventModel, HardwareModel, JobModel, TERMINAL_STATUSES, type Job } from "../models/index.ts";
import { validatePricingQuote, uint256 } from '../pricing.ts';
import { STATUS_FOR_EVENT } from "../models/JobStatus.ts";
import type { ChainEvent } from "./chain.ts";
import type { Matcher } from "./matcher.ts";

async function accountForAddress(address: unknown, job: Job) {
  const assigned = job.assignedRates.find(rate => rate.wallet?.toLowerCase() === String(address).toLowerCase());
  if (assigned?.provider) return assigned.provider;
	const hw = await HardwareModel.findOne({ address: String(address).toLowerCase() });
	return hw?.userRef ?? (await AccountModel.findOne({ walletIds: String(address).toLowerCase() }))?._id ?? null;
}

const IGNORED_EVENTS = new Set(["COMMITTED", "REVEALED", "CONSENSUS_REACHED"]);

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
	const job = await JobModel.findOne({ onChainJobId: jobId });
	if (!job) {
		console.warn(`${name}: job ${jobId} isn't in the database; ignoring`);
		return;
	}

	switch (name) {
		case "JOB_SUBMITTED":
      if (!await matcher.validateSubmission(jobId)) return;
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

    case 'PAID':
    case 'STAKE_RETURNED':
    case 'SLASH_REWARD':
    case 'SLASHED': {
      if (typeof args.amount !== 'bigint') throw new TypeError(`${name} requires an explicit wei amount.`);
      const amount = Types.Decimal128.fromString(formatEther(uint256(args.amount)));
      const account = await accountForAddress(args.provider, job);
      if (account) {
        const inc = name === 'PAID' ? { totalEarned: amount, reputation: 1 } : name === 'SLASH_REWARD' ? { totalEarned: amount } : name === 'SLASHED' ? { reputation: -1 } : {};
        await AccountModel.updateOne({ _id: account, processedChainEvents: { $ne: effectId } },
          { ...(Object.keys(inc).length ? { $inc: inc } : {}), $addToSet: { processedChainEvents: effectId } });
      }
      const field = name === 'PAID' ? 'workPaid' : name === 'STAKE_RETURNED' ? 'stakeReturned' : name === 'SLASH_REWARD' ? 'slashRewards' : 'slashed';
      await JobModel.updateOne({ _id: job._id, processedChainEvents: { $ne: effectId } },
        { $inc: { [field]: amount }, $addToSet: { processedChainEvents: effectId } });
      return;
    }
    case 'JOB_SETTLED': {
      const quote = validatePricingQuote(job);
      for (const key of ['escrow', 'workPaid', 'refund', 'slashedStake']) {
        if (typeof args[key] !== 'bigint') throw new TypeError(`JOB_SETTLED requires ${key} in wei.`);
        uint256(args[key] as bigint);
      }
      const escrow = args.escrow as bigint, work = args.workPaid as bigint, refund = args.refund as bigint;
      if (String(args.buyer).toLowerCase() !== job.buyerWallet?.toLowerCase() ||
          escrow !== BigInt(quote.totalEscrowWei) || work + refund !== escrow) {
        throw new TypeError('JOB_SETTLED does not match the pinned buyer/escrow.');
      }
      // Each account and job applies its own effect and dedupe key atomically. A partial
      // failure can replay safely without charging work twice or fabricating stake earnings.
      await AccountModel.updateOne({ _id: job.owner, processedChainEvents: { $ne: effectId } },
        { $inc: { totalSpent: Types.Decimal128.fromString(formatEther(work)) }, $addToSet: { processedChainEvents: effectId } });
      await JobModel.updateOne({ _id: job._id, processedChainEvents: { $ne: effectId } },
        { $set: { settlement: { version: 1, status: 'settled', escrowWei: String(escrow), workChargedWei: String(work),
          buyerRefundWei: String(refund), slashedStakeWei: String(args.slashedStake) } },
          $addToSet: { processedChainEvents: effectId } });
      return;
    }
	}

	const status = STATUS_FOR_EVENT[name];
	if (!status) {
		console.warn(`Unhandled contract event ${name}`);
		return;
	}
	job.status = status;
	await job.save();

	if (TERMINAL_STATUSES.includes(status)) {
		await AccountModel.updateOne({ _id: job.owner }, { $addToSet: { completedJobs: job._id } });
		matcher.release(job.onChainJobId);
		await matcher.ping(); // its providers are free again
	}
}
