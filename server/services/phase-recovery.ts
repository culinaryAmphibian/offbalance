import { ACTIVE_STATUSES, JobModel, TERMINAL_STATUSES } from "../models/index.ts";

/** MongoDB owns the durable work list; contract reads decide the current action. */
export async function unfinishedPhaseJobIds(): Promise<number[]> {
	return JobModel.distinct("onChainJobId", {
		status: { $nin: TERMINAL_STATUSES },
		$or: [{ submittedAt: { $ne: null } }, { status: { $in: ACTIVE_STATUSES } }, { "providers.0": { $exists: true } }],
	});
}
