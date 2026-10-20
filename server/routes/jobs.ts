// /jobs: buyers submit and follow jobs; providers see the jobs they're on.
import { Router } from "express";
import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { isValidObjectId } from "mongoose";
import { requireAuth } from "../middleware/auth.ts";
import { AccountModel, BuildModel, BuildStatus, JobModel, JobStatus, nextSeq } from "../models/index.ts";
import { registry } from "../services/registry.ts";
import { loadJob, type Deps } from "./deps.ts";
import { serializeJob, serializeResults } from "./serialize.ts";

const SETTABLE = [
	"name", "dockerImageDigest", "command", "env", "inputUrl", "cpuLimit", "memLimitMb",
	"maxPrice", "minNodesToRunOn", "minNodesToAgree", "timeWindow", "requirements",
] as const;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

export function jobRoutes({ chain, matcher }: Deps): Router {
	const router = Router();
	const browserJob = (job: Parameters<typeof serializeJob>[0], me: unknown, wallet: string) => ({
		...serializeJob(job), executionMode: chain ? "chain" : "local",
		canViewResults: String(job.owner) === String(me),
		...(String(job.owner) === String(me) ? { submitWallet: wallet } : {}),
		canSubmit: String(job.owner) === String(me) && Boolean(chain) && config.contract === "real" && !job.submittedAt && job.status === JobStatus.PENDING,
	});
	router.use("/jobs", requireAuth);

	// Creates the job and reserves its on-chain id. The buyer's wallet then calls
	// submitJob(id, price, k, quorum, timeWindow); matching starts on JOB_SUBMITTED.
	//
	// The image is one of:
	//   image             any reference ("python:3.12"); the server pins it by digest
	//   buildId           a finished build from POST /builds
	//   dockerImageDigest already pinned (`repo@sha256:...`), used as is
	router.post("/jobs", async (req, res) => {
		const requestKey = req.get("Idempotency-Key");
		if (requestKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(requestKey)) {
			res.status(400).json({ error: "Idempotency-Key must be 1-128 letters, numbers, dots, underscores, colons or hyphens" });
			return;
		}
		const requestHash = createHash("sha256").update(JSON.stringify(canonical(req.body ?? {}))).digest("hex");
		const replay = async () => {
			const existing = requestKey && await JobModel.findOne({ owner: res.locals.account._id, requestKey });
			if (!existing) return false;
			if (existing.requestHash !== requestHash) res.status(409).json({ error: "This submission key was already used with different job details" });
			else {
				await AccountModel.updateOne({ _id: existing.owner }, { $addToSet: { submittedJobs: existing._id } });
				if (!chain) void matcher.ping().catch(error => console.error("Matching failed:", error));
				res.json({ job: browserJob(existing, res.locals.account._id, res.locals.wallet) });
			}
			return true;
		};
		if (await replay()) return;
		const fields: Record<string, unknown> = Object.fromEntries(
			SETTABLE.filter((k) => req.body?.[k] !== undefined).map((k) => [k, req.body[k]]),
		);
		const given = ["image", "buildId", "dockerImageDigest"].filter((k) => req.body?.[k] !== undefined);
		if (given.length !== 1) {
			res.status(400).json({ error: "give exactly one of image, buildId, dockerImageDigest" });
			return;
		}
		if (given[0] === "image") {
			fields.dockerImageDigest = (await registry.resolve(String(req.body.image))).image;
		} else if (given[0] === "buildId") {
			const build = isValidObjectId(req.body.buildId) && await BuildModel.findById(req.body.buildId);
			if (!build || !build.owner.equals(res.locals.account._id)) {
				res.status(400).json({ error: "no such build" });
				return;
			}
			if (build.status !== BuildStatus.DONE) {
				res.status(409).json({ error: `build is ${build.status}` });
				return;
			}
			fields.dockerImageDigest = build.image;
		}

		const job = new JobModel({ ...fields, owner: res.locals.account._id, onChainJobId: 0, ...(requestKey ? { requestKey, requestHash } : {}) });
		await job.validate(); // before using up an id
		job.onChainJobId = await nextSeq("jobId");
		if (!chain) job.submittedAt = new Date(); // no chain to wait for
		try { await job.save(); }
		catch (error) {
			if ((error as { code?: number }).code === 11000 && await replay()) return;
			throw error;
		}
		await AccountModel.updateOne({ _id: job.owner }, { $addToSet: { submittedJobs: job._id } });
		if (!chain) void matcher.ping().catch(error => console.error("Matching failed:", error));
		res.status(201).json({ job: browserJob(job, res.locals.account._id, res.locals.wallet) });
	});

	// ?role=buyer (default): jobs I submitted; ?role=provider: jobs I'm running
	router.get("/jobs", async (req, res) => {
		const me = res.locals.account._id;
		const filter = req.query.role === "provider" ? { providers: me } : { owner: me };
		const jobs = await JobModel.find(filter).sort({ createdAt: -1 }).limit(100);
		res.json({ jobs: jobs.map(job => browserJob(job, me, res.locals.wallet)) });
	});

	router.get("/jobs/:jobId", async (req, res) => {
		const job = await loadJob(req, res);
		if (!job) return;
		const me = res.locals.account._id;
		if (!job.owner.equals(me) && !job.providers.some((p) => p.equals(me))) {
			res.status(403).json({ error: "not your job" });
			return;
		}
		res.json({ job: browserJob(job, res.locals.account._id, res.locals.wallet) });
	});

	// Before it's on-chain the server can cancel it outright; after that only the
	// buyer's cancelJob() can, and the CANCELED event updates the status.
	router.post("/jobs/:jobId/cancel", async (req, res) => {
		const job = await loadJob(req, res);
		if (!job) return;
		if (!job.owner.equals(res.locals.account._id)) {
			res.status(403).json({ error: "not your job" });
			return;
		}
		if (job.status !== JobStatus.PENDING || job.providers.length > 0) {
			res.status(409).json({ error: `job is ${job.status}${job.providers.length ? " with providers assigned" : ""}; it can't be canceled` });
			return;
		}
		if (chain && job.submittedAt) {
			res.status(409).json({ error: `job is on-chain; call cancelJob(${job.onChainJobId}) from your wallet` });
			return;
		}
		job.status = JobStatus.CANCELED;
		await job.save();
		res.json({ job: browserJob(job, res.locals.account._id, res.locals.wallet) });
	});

	router.get("/jobs/:jobId/result", async (req, res) => {
		const job = await loadJob(req, res);
		if (!job) return;
		if (!job.owner.equals(res.locals.account._id)) {
			res.status(403).json({ error: "not your job" });
			return;
		}
		res.json({ status: job.status, results: serializeResults(job) });
	});

	return router;
}
