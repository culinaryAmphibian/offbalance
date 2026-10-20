// Routes the provider client calls (client/server/ServerManager.py, client/main.py).
// Kept in step with dev-server.ts by test/client-contract.test.ts.
import { Router } from "express";
import { numericJobId } from "../adapters/repository.ts";
import { requireAuth } from "../middleware/auth.ts";
import { HardwareModel, JobModel } from "../models/index.ts";
import { readDeployment } from "../services/chain.ts";
import type { Deps } from "./deps.ts";

export function clientRoutes({ matcher }: Deps): Router {
	const router = Router();

	router.get("/contract_address", requireAuth, (_req, res) => {
		try {
			res.json({ address: readDeployment().address });
		} catch (e) {
			res.status(503).json({
				error: "can't read the deployment file; run `npm run dev` in blockchain/",
				detail: String(e),
			});
		}
	});

	// machine specs from the client's benchmark; form-encoded, gpu absent when there's no GPU
	router.post("/scores", requireAuth, async (req, res) => {
		const { cpu, gpu, mem } = req.body ?? {};
		const scores = {
			cpuScore: Number(cpu),
			gpuScore: gpu === undefined || gpu === "" ? null : Number(gpu),
			memoryScore: Number(mem),
		};
		if (cpu === undefined || mem === undefined ||
			![scores.cpuScore, scores.memoryScore, scores.gpuScore ?? 0].every((n) => Number.isFinite(n) && n >= 0)) {
			res.status(400).json({ error: "cpu and mem are required, gpu is optional; all non-negative numbers" });
			return;
		}

		const account = res.locals.account;
		const hw = await HardwareModel.findOneAndUpdate(
			{ userRef: account._id },
			// the client signs with the wallet its API key was issued to
			{ ...scores, address: res.locals.wallet },
			{ upsert: true, returnDocument: "after", runValidators: true },
		);
		if (!account.hardware?.equals(hw._id)) {
			account.hardware = hw._id;
			await account.save();
		}
		void matcher.ping().catch(error => console.error("Matching failed:", error));
		res.status(201).json({ ok: true, scores: { cpu: hw.cpuScore, gpu: hw.gpuScore, mem: hw.memoryScore } });
	});

	// what to run; only for providers assigned to the job
	router.get("/jobManifest/:jobId", requireAuth, async (req, res) => {
		const jobId = numericJobId(String(req.params.jobId));
		if (jobId === null) {
			res.status(400).json({ error: "jobId must be a non-negative integer" });
			return;
		}
		const job = await JobModel.findOne({ onChainJobId: jobId });
		if (!job) {
			res.status(404).json({ error: `no job ${jobId}` });
			return;
		}
		if (!job.providers.some((p) => p.equals(res.locals.account._id))) {
			res.status(403).json({ error: `you aren't assigned to job ${jobId}` });
			return;
		}
		res.json({
			manifest: {
				jobId,
				image: job.dockerImageDigest,
				command: job.command,
				env: Object.fromEntries(job.env ?? []),
				input_url: job.inputUrl,
				timeout_s: job.timeWindow,
				cpu_limit: job.cpuLimit,
				mem_limit_mb: job.memLimitMb,
			},
		});
	});

	return router;
}
