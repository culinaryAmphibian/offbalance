import { ACTIVE_STATUSES, JobModel, TERMINAL_STATUSES } from "../models/index.ts";
import { contractJobId } from "../models/Job.ts";

export async function unfinishedPhaseJobIds(): Promise<number[]> {
	const jobs = await JobModel.find({
		status: { $nin: TERMINAL_STATUSES },
		$or: [{ submittedAt: { $ne: null } }, { status: { $in: ACTIVE_STATUSES } }, { "providers.0": { $exists: true } }],
	}).select("onChainJobId contractJobId quoteId").lean();

	return [...new Set(jobs.filter(job => !job.quoteId || job.contractJobId != null).map(contractJobId))];
}
