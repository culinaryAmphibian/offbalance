import type { Request, Response } from "express";
import { numericJobId } from "../adapters/repository.ts";
import type { HydratedDocument } from "mongoose";
import { JobModel, type Job } from "../models/index.ts";
import type { Builder } from "../services/builder.ts";
import type { Chain } from "../services/chain.ts";
import type { Matcher } from "../services/matcher.ts";

export type Deps = { chain: Chain | null; matcher: Matcher; builder: Builder };

// Loads :jobId (the on-chain id) or answers 400/404 and returns null.
export async function loadJob(req: Request, res: Response): Promise<HydratedDocument<Job> | null> {
	const raw = String(req.params.jobId);
	const id = numericJobId(raw);
	if (id === null) {
		res.status(400).json({ error: "jobId must be a non-negative integer" });
		return null;
	}
	const job = await JobModel.findOne({ onChainJobId: id });
	if (!job) res.status(404).json({ error: `no job ${raw}` });
	return job;
}
