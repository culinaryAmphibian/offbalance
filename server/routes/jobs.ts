// /jobs: buyers submit and follow jobs; providers see the jobs they're on.
import { Router } from "express";
import { isValidObjectId } from "mongoose";
import { requireAuth } from "../middleware/auth.ts";
import { AccountModel, BuildModel, BuildStatus, JobModel, JobStatus, nextSeq } from "../models/index.ts";
import { registry } from "../services/registry.ts";
import { loadJob, type Deps } from "./deps.ts";
import { serializeJob, serializeResults } from "./serialize.ts";

const SETTABLE = [
	"dockerImageDigest", "command", "env", "inputUrl", "cpuLimit", "memLimitMb",
	"maxPrice", "minNodesToRunOn", "minNodesToAgree", "timeWindow", "requirements",
] as const;

export function jobRoutes({ chain, matcher }: Deps): Router {
	const router = Router();
	router.use("/jobs", requireAuth);

	// Creates the job and reserves its on-chain id. The buyer's wallet then calls
	// submitJob(id, price, k, quorum, timeWindow); matching starts on JOB_SUBMITTED.
	//
	// The image is one of:
	//   image             any reference ("python:3.12"); the server pins it by digest
	//   buildId           a finished build from POST /builds
	//   dockerImageDigest already pinned (`repo@sha256:...`), used as is
	router.post("/jobs", async (req, res) => {
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

		const job = new JobModel({ ...fields, owner: res.locals.account._id, onChainJobId: 0 });
		await job.validate(); // before using up an id
		job.onChainJobId = await nextSeq("jobId");
		if (!chain) job.submittedAt = new Date(); // no chain to wait for
		await job.save();
		await AccountModel.updateOne({ _id: job.owner }, { $addToSet: { submittedJobs: job._id } });
		if (!chain) void matcher.ping().catch(error => console.error("Matching failed:", error));
		res.status(201).json({ job: serializeJob(job) });
	});

	// ?role=buyer (default): jobs I submitted; ?role=provider: jobs I'm running
	router.get("/jobs", async (req, res) => {
		const me = res.locals.account._id;
		const filter = req.query.role === "provider" ? { providers: me } : { owner: me };
		const jobs = await JobModel.find(filter).sort({ createdAt: -1 }).limit(100);
		res.json({ jobs: jobs.map(serializeJob) });
	});

	router.get("/jobs/:jobId", async (req, res) => {
		const job = await loadJob(req, res);
		if (!job) return;
		const me = res.locals.account._id;
		if (!job.owner.equals(me) && !job.providers.some((p) => p.equals(me))) {
			res.status(403).json({ error: "not your job" });
			return;
		}
		res.json({ job: serializeJob(job) });
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
		res.json({ job: serializeJob(job) });
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
