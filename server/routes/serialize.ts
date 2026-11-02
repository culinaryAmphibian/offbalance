// API shapes: `id` instead of `_id`, decimals as strings.
import type { Types } from "mongoose";
import { formatEther, parseEther } from "viem";
import { decimalString } from "../models/decimal.ts";
import { JobStatus } from "../models/JobStatus.ts";
import type { Account, Hardware, Job } from "../models/index.ts";
import { REFERENCE, relativeScores, type HardwareProfile } from "../services/hardware.ts";

type WithId<T> = T & { _id: Types.ObjectId };

const dec = (v: Types.Decimal128 | null | undefined) => (v == null ? null : decimalString(v));

const DELIVERY_PHASES = new Set<string>([JobStatus.AWAITING_DELIVERY, JobStatus.DELIVERY_RECEIPT_VALIDATION]);

// What the job view's Result box shows. Delivery is "the agreed output reached the server";
// payment follows the buyer's escrow: held, paid out to providers, or refunded.
export function deliveryState(job: WithId<Job>) {
	const delivered = job.results.filter(r => r.contentVerified);
	const first = (dates: Date[]) => dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))) : null;
	const receivedAt = first(delivered.map(r => r.deliveryTime));
	const verifiedAt = first(delivered.filter(r => r.receiptVerified || r.receiptMode === "offchain" || r.receiptMode === "local").map(r => r.deliveryTime));
	let status: string;
	if (delivered.length) status = "DELIVERED";
	else if (DELIVERY_PHASES.has(job.status)) status = "AWAITING_DELIVERY";
	else if (job.status === JobStatus.PAYOUT) status = "NOT_DELIVERED";
	else if (job.status === JobStatus.NO_QUORUM) status = "NO_CONSENSUS";
	else if (job.status === JobStatus.CANCELED) status = "CANCELED";
	else status = "NOT_STARTED";
	return { status, providersDelivered: delivered.length, receivedAt, verifiedAt };
}

export function paymentState(job: WithId<Job>) {
	const settledAt = job.settledAt ?? null;
	const payouts = (job.payouts ?? []).filter(p => p.amount != null)
		.map(p => ({ provider: String(p.provider), amount: decimalString(p.amount!) }));
	const paid = sumEth(payouts.map(p => p.amount));
	let status: string;
	if (job.status === JobStatus.PAYOUT) status = "PAID";
	// no consensus: the buyer gets the price back and providers get their stakes back
	else if (job.status === JobStatus.NO_QUORUM || job.status === JobStatus.CANCELED) status = "REFUNDED";
	else if (job.submittedAt) status = "ESCROWED";
	else status = "NOT_STARTED";
	return { status, settledAt: status === "PAID" || status === "REFUNDED" ? settledAt : null,
		paidToProviders: status === "PAID" ? paid : null, payouts };
}

// exact decimal ETH sum, through wei
function sumEth(amounts: string[]): string {
	const wei = amounts.reduce((sum, a) => sum + parseEther(a), 0n);
	return decimalString(formatEther(wei));
}

export function serializeJob(job: WithId<Job>) {
	const result = job.results.find(r => r.contentVerified && r.retainedUntil && r.retainedUntil.getTime() > Date.now());
	const payment = paymentState(job);
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
		runningPrice: dec(job.runningPrice),
		minNodesToRunOn: job.minNodesToRunOn,
		minNodesToAgree: job.minNodesToAgree,
		timeWindow: job.timeWindow,
		requirements: job.requirements,
		createdAt: job.createdAt,
		delivery: deliveryState(job),
		payment,
		// what the buyer ended up paying: the escrowed price once settled, nothing if refunded
		spent: payment.status === "PAID" ? dec(job.maxPrice) : payment.status === "REFUNDED" ? "0" : null,
		result: result ? { available: true, filename: result.filename, hash: result.hash,
			size: result.size, deliveryTime: result.deliveryTime, retainedUntil: result.retainedUntil,
			receiptVerified: result.receiptVerified, receiptMode: result.receiptMode } : { available: false },
	};
}

export function serializeResults(job: WithId<Job>) {
	return job.results.map((r) => ({
		provider: String(r.provider),
		hash: r.hash,
		contentVerified: r.contentVerified,
		receiptMode: r.receiptMode,
		archiveHash: r.archiveHash,
		size: r.size,
		filename: r.filename,
		retainedUntil: r.retainedUntil,
		deliveryTime: r.deliveryTime,
		receiptVerified: r.receiptVerified,
	}));
}

export function serializeHardware(hw: WithId<Hardware>) {
	return {
		id: String(hw._id),
		address: hw.address,
		cpu: hw.cpu,
		memory: hw.memory,
		gpus: hw.gpus,
		// null for a record from before hardware profiles
		relative: hw.cpu && hw.memory ? { ...relativeScores(hw as unknown as HardwareProfile), reference: REFERENCE.description } : null,
		price: hw.price,
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
