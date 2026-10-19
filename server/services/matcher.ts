// Match manager: event-based, top-k matching of submitted jobs to idle providers.
import type { HydratedDocument, Types } from "mongoose";
import { AccountModel, HardwareModel, JobModel, JobStatus, TERMINAL_STATUSES, type Hardware, type Job } from "../models/index.ts";
import { errorMessage, type Chain } from "./chain.ts";

// Providers that fit the job, cheapest first (ties: strongest CPU), at most k.
// Excludes providers already on an unfinished job (one job at a time) and the
// buyer's own machine, since a buyer shouldn't verify their own job.
export async function findMatchingScores(job: Job & { _id: Types.ObjectId }): Promise<HydratedDocument<Hardware>[]> {
	const busy = await JobModel.distinct("providers", { status: { $nin: TERMINAL_STATUSES } });
	const req = job.requirements ?? { minCpuScore: 0, minGpuScore: 0, minMemoryScore: 0 };

	const filter: Record<string, unknown> = {
		userRef: { $nin: [...busy, job.owner] },
		price: { $ne: null, $lte: Number(job.maxPrice.toString()) },
		cpuScore: { $gte: req.minCpuScore },
		memoryScore: { $gte: req.minMemoryScore },
	};
	if (req.minGpuScore > 0) filter.gpuScore = { $gte: req.minGpuScore };

	return HardwareModel.find(filter)
		.sort({ price: 1, cpuScore: -1, gpuScore: -1, memoryScore: -1 })
		.limit(job.minNodesToRunOn);
}

export class Matcher {
	private queue: Promise<void> = Promise.resolve();
	private chain: Chain | null;

	constructor(chain: Chain | null) {
		this.chain = chain;
	}

	// Something changed (job submitted, provider scored/priced, a job finished):
	// try to match every waiting job. Runs are serialized so a provider is never
	// handed two jobs by overlapping runs.
	ping(): Promise<void> {
		this.queue = this.queue
			.then(() => this.run())
			.catch((e) => console.error("Matching failed:", e));
		return this.queue;
	}

	private async run(): Promise<void> {
		const waiting = await JobModel.find({
			status: JobStatus.PENDING,
			submittedAt: { $ne: null },
			providers: { $size: 0 },
		}).sort({ submittedAt: 1 });

		for (const job of waiting) {
			const matches = await findMatchingScores(job);
			if (matches.length < job.minNodesToRunOn) continue; // wait for more providers
			await this.assign(job, matches);
		}
	}

	private async assign(job: HydratedDocument<Job>, matches: HydratedDocument<Hardware>[]): Promise<void> {
		const accountIds = matches.map((h) => h.userRef);
		const runningPrice = Math.max(...matches.map((h) => h.price ?? 0));

		// database first: providers fetch /jobManifest as soon as they see PROVIDER_SELECTED
		job.set({ providers: accountIds, runningPrice: String(runningPrice) });
		await job.save();
		await AccountModel.updateMany({ _id: { $in: accountIds } }, { $addToSet: { takenJobs: job._id } });

		try {
			await this.chain?.assignProviders(job.onChainJobId, matches.map((h) => h.address));
			console.log(`Job ${job.onChainJobId}: assigned ${matches.map((h) => h.address).join(", ")}`);
		} catch (e) {
			// undo so the next ping retries
			console.error(`Job ${job.onChainJobId}: assignProviders failed, unassigning:`, errorMessage(e));
			job.set({ providers: [], runningPrice: "0" });
			await job.save();
			await AccountModel.updateMany({ _id: { $in: accountIds } }, { $pull: { takenJobs: job._id } });
		}
	}
}
