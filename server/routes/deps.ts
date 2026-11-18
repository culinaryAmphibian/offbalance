import type { Request, Response } from "express";
import { numericJobId } from "../adapters/repository.ts";
import type { HydratedDocument } from "mongoose";
import { JobModel, type Job } from "../models/index.ts";
import { findContractJob } from "../models/Job.ts";
import type { Builder } from "../services/builder.ts";
import type { Chain } from "../services/chain.ts";
import type { Matcher } from "../services/matcher.ts";

import type { ResultStore } from "../storage/results.ts";

export type Deps = { chain: Chain | null; matcher: Matcher; builder: Builder; results?: ResultStore | null };

// Loads :jobId in the browser or provider id space.
export async function loadJob(req: Request, res: Response, useContractId = false): Promise<HydratedDocument<Job> | null> {
	const raw = String(req.params.jobId);
	const id = numericJobId(raw);
	if (id === null) {
		res.status(400).json({ error: "jobId must be a non-negative integer" });
		return null;
	}
	const job = useContractId ? await findContractJob(id) : await JobModel.findOne({ onChainJobId: id });
	if (!job) res.status(404).json({ error: `no job ${raw}` });
	return job;
}
