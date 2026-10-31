// API shapes: `id` instead of `_id`, decimals as strings.
import type { Types } from "mongoose";
import { decimalString } from "../models/decimal.ts";
import { formatEthAmount, parseEthAmount } from '../matching/MatchingEngine.ts';
import { validatePricingQuote } from '../pricing.ts';
import type { Account, Hardware, Job } from "../models/index.ts";

type WithId<T> = T & { _id: Types.ObjectId };

const dec = (v: Types.Decimal128 | null | undefined) => (v == null ? null : decimalString(v));

export function serializeJob(job: WithId<Job>) {
  let pricing = null;
  try { pricing = validatePricingQuote(job); } catch { /* legacy quotes require explicit migration */ }
  const settlement = job.settlement ? {
    version: job.settlement.version, status: job.settlement.status,
    escrowWei: job.settlement.escrowWei, workChargedWei: job.settlement.workChargedWei,
    buyerRefundWei: job.settlement.buyerRefundWei, slashedStakeWei: job.settlement.slashedStakeWei,
    escrow: formatEthAmount(BigInt(job.settlement.escrowWei!)),
    workCharged: formatEthAmount(BigInt(job.settlement.workChargedWei!)),
    buyerRefund: formatEthAmount(BigInt(job.settlement.buyerRefundWei!)),
    slashedStake: formatEthAmount(BigInt(job.settlement.slashedStakeWei!)),
    stakeReturned: dec(job.stakeReturned), stakeReturnedWei: String(parseEthAmount(dec(job.stakeReturned) ?? '0')),
  } : null;
  return {
		id: job.onChainJobId,
		name: job.name,
		owner: String(job.owner),
		status: job.status,
		submittedAt: job.submittedAt,
		providers: job.providers.map(String),
		dockerImageDigest: job.dockerImageDigest,
		command: job.command,
		env: Object.fromEntries(job.env ?? []),
		inputUrl: job.inputUrl,
		cpuLimit: job.cpuLimit,
		memLimitMb: job.memLimitMb,
		maxPrice: dec(job.maxPrice),
    buyerWallet: job.buyerWallet ?? null,
    pricing, pricingMigrationRequired: pricing === null || !job.buyerWallet,
    submissionValidationError: job.submissionValidationError,
    assignedRates: job.assignedRates.map(rate => ({ ...rate.toObject(), provider: String(rate.provider) })),
    quotedTotal: dec(job.quotedTotal), quotedTotalWei: String(parseEthAmount(dec(job.quotedTotal) ?? '0')),
    settlement,
    workPaid: dec(job.workPaid), slashRewards: dec(job.slashRewards), stakeReturned: dec(job.stakeReturned), slashed: dec(job.slashed),
		runningPrice: dec(job.runningPrice),
		minNodesToRunOn: job.minNodesToRunOn,
		minNodesToAgree: job.minNodesToAgree,
		timeWindow: job.timeWindow,
		requirements: job.requirements,
		createdAt: job.createdAt,
	};
}

export function serializeResults(job: WithId<Job>) {
	return job.results.map((r) => ({
		provider: String(r.provider),
		hash: r.hash,
		location: r.location,
		deliveryTime: r.deliveryTime,
		receiptVerified: r.receiptVerified,
	}));
}

export function serializeHardware(hw: WithId<Hardware>) {
	return {
		id: String(hw._id),
		address: hw.address,
		cpuScore: hw.cpuScore,
		gpuScore: hw.gpuScore,
		memoryScore: hw.memoryScore,
		price: hw.price == null ? null : decimalString(hw.price),
		updatedAt: hw.updatedAt,
	};
}

export function serializeAccount(account: WithId<Account>) {
	return {
		id: String(account._id),
		walletIds: account.walletIds,
		currentStake: dec(account.currentStake),
		reputation: account.reputation,
		totalSpent: dec(account.totalSpent),
		totalEarned: dec(account.totalEarned),
		createdAt: account.createdAt,
	};
}
