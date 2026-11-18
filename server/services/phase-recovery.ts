import { ACTIVE_STATUSES, JobModel, TERMINAL_STATUSES } from "../models/index.ts";

export async function unfinishedPhaseJobIds(): Promise<number[]> {
	return JobModel.distinct("onChainJobId", {
		status: { $nin: TERMINAL_STATUSES },
		$or: [{ submittedAt: { $ne: null } }, { status: { $in: ACTIVE_STATUSES } }, { "providers.0": { $exists: true } }],
	});
}
