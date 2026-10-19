// /provider: tutorial, the provider's machine and pricing, and result delivery.
import { Router } from "express";
import { decimalString } from "../models/decimal.ts";
import { hourlyPrice } from "../adapters/repository.ts";
import { requireAuth } from "../middleware/auth.ts";
import { HardwareModel, JobModel, JobStatus, TutorialModel } from "../models/index.ts";
import { errorMessage } from "../services/chain.ts";
import { providerControlRoutes } from "../services/providers.ts";
import { loadJob, type Deps } from "./deps.ts";
import { serializeHardware, serializeResults } from "./serialize.ts";

function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// market price suggestion: the median rate of machines with a similar CPU score,
// or of every priced machine if none are similar
async function suggestedPrice(cpuScore: number, exclude: unknown): Promise<number | null> {
	const priced = { price: { $ne: null }, _id: { $ne: exclude } };
	const similar = await HardwareModel.find({ ...priced, cpuScore: { $gte: cpuScore * 0.75, $lte: cpuScore * 1.25 } }, "price");
	const pool = similar.length ? similar : await HardwareModel.find(priced, "price");
	return median(pool.map((h) => h.price!));
}

export function providerRoutes({ chain, matcher }: Deps): Router {
	const router = Router();
	router.use(providerControlRoutes(matcher));

	router.get("/provider/tutorial", async (_req, res) => {
		const tutorial = await TutorialModel.findOne().sort({ updatedAt: -1 });
		if (!tutorial) {
			res.status(404).json({ error: "no tutorial yet" });
			return;
		}
		res.json({ text: tutorial.text, updatedAt: tutorial.updatedAt });
	});

	router.get("/provider/hardware", requireAuth, async (_req, res) => {
		const hw = await HardwareModel.findOne({ userRef: res.locals.account._id });
		const live = hw && matcher.manager.pool.get(hw.address);
		const timeout = matcher.manager.pool.heartbeatTimeoutMs;
		const online = Boolean(live && live.lastHeartbeat > 0 && live.lastHeartbeat <= Date.now() && Date.now() - live.lastHeartbeat <= timeout);
		res.json({ hardware: hw ? serializeHardware(hw) : null,
			suggestedPrice: hw ? await suggestedPrice(hw.cpuScore, hw._id) : null,
			online, lastSeen: live?.lastHeartbeat ? new Date(live.lastHeartbeat).toISOString() : null });
	});

	// per-hour rate; machines aren't matched until they have one
	router.post("/provider/price", requireAuth, async (req, res) => {
		const price = Number(req.body?.price);
		let validPrice = typeof req.body?.price === "string" || typeof req.body?.price === "number";
		let priceError = "price must be non-negative finite ETH with at most 18 decimal places";
		try {
			if (hourlyPrice(price) !== decimalString(req.body.price)) {
				validPrice = false;
				priceError = "This price exceeds the stored rate precision. Use fewer significant digits.";
			}
		} catch { validPrice = false; }
		if (!validPrice) {
			res.status(400).json({ error: priceError });
			return;
		}
		const hw = await HardwareModel.findOneAndUpdate(
			{ userRef: res.locals.account._id },
			{ price },
			{ returnDocument: "after", runValidators: true },
		);
		if (!hw) {
			res.status(404).json({ error: "no machine yet; run the provider client to benchmark it" });
			return;
		}
		void matcher.ping().catch(error => console.error("Matching failed:", error));
		res.json({ hardware: serializeHardware(hw) });
	});

	router.post("/provider/heartbeat", requireAuth, async (_req, res) => {
		if (!(await matcher.heartbeat(res.locals.wallet))) {
			res.status(409).json({ error: "no machine yet; report /scores first" });
			return;
		}
		res.json({ ok: true, heartbeatTimeoutMs: matcher.manager.pool.heartbeatTimeoutMs });
	});

	// Delivery receipt: the provider uploaded its output and says where. The
	// server records it and confirms the receipt on-chain, which payment depends on.
	router.post("/provider/results/:jobId", requireAuth, async (req, res) => {
		const job = await loadJob(req, res);
		if (!job) return;
		const me = res.locals.account._id;
		if (!job.providers.some((p) => p.equals(me))) {
			res.status(403).json({ error: `you aren't assigned to job ${job.onChainJobId}` });
			return;
		}
		if (job.status !== JobStatus.AWAITING_DELIVERY && job.status !== JobStatus.DELIVERY_RECEIPT_VALIDATION) {
			res.status(409).json({ error: `job is ${job.status}, not taking deliveries` });
			return;
		}
		const { hash, location } = req.body ?? {};
		if (typeof hash !== "string" || !hash || typeof location !== "string" || !location) {
			res.status(400).json({ error: "hash and location are required" });
			return;
		}

		// Atomic updates guarded by status, so a concurrent delivery or phase event
		// (e.g. DELIVERED -> PAYOUT) is never overwritten by a stale copy of the job.
		const deliveryTime = new Date();
		const open = { _id: job._id, status: { $in: [JobStatus.AWAITING_DELIVERY, JobStatus.DELIVERY_RECEIPT_VALIDATION] } };
		const status = { status: JobStatus.DELIVERY_RECEIPT_VALIDATION };
		let saved = await JobModel.updateOne(
			{ ...open, "results.provider": { $ne: me } },
			{ $push: { results: { provider: me, hash, location, deliveryTime } }, $set: status },
			{ runValidators: true },
		);
		if (!saved.matchedCount) {
			// redelivery: replace an unverified result
			saved = await JobModel.updateOne(
				{ ...open, results: { $elemMatch: { provider: me, receiptVerified: false } } },
				{ $set: { "results.$.hash": hash, "results.$.location": location, "results.$.deliveryTime": deliveryTime, ...status } },
				{ runValidators: true },
			);
		}
		if (!saved.matchedCount) {
			const latest = await JobModel.findById(job._id);
			const verified = latest?.results.some((r) => r.provider.equals(me) && r.receiptVerified);
			res.status(409).json({ error: verified ? "your delivery is already verified" : `job is ${latest?.status}, not taking deliveries` });
			return;
		}

		if (chain?.canWrite) {
			try {
				const hw = await HardwareModel.findOne({ userRef: me });
				await chain.verifyReceipt(job.onChainJobId, hw?.address ?? res.locals.wallet);
				await JobModel.updateOne({ _id: job._id, "results.provider": me }, { $set: { "results.$.receiptVerified": true } });
			} catch (e) {
				console.error(`Job ${job.onChainJobId}: verifyReceipt failed:`, errorMessage(e));
			}
		}
		const latest = (await JobModel.findById(job._id))!;
		res.status(201).json({ results: serializeResults(latest).filter((r) => r.provider === String(me)) });
	});

	return router;
}
