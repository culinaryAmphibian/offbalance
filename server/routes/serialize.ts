// API shapes: `id` instead of `_id`, decimals as strings.
import type { Types } from "mongoose";
import type { Account, Hardware, Job } from "../models/index.ts";

type WithId<T> = T & { _id: Types.ObjectId };

const dec = (v: Types.Decimal128 | null | undefined) => (v == null ? null : v.toString());

export function serializeJob(job: WithId<Job>) {
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
