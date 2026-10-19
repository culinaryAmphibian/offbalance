// /provider: tutorial, the provider's machine and pricing, and result delivery.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import { HardwareModel, JobStatus, TutorialModel } from "../models/index.ts";
import { errorMessage } from "../services/chain.ts";
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
		if (!hw) {
			res.status(404).json({ error: "no machine yet; run the provider client to benchmark it" });
			return;
		}
		res.json({ hardware: serializeHardware(hw), suggestedPrice: await suggestedPrice(hw.cpuScore, hw._id) });
	});

	// per-hour rate; machines aren't matched until they have one
	router.post("/provider/price", requireAuth, async (req, res) => {
		const price = Number(req.body?.price);
		if (req.body?.price === undefined || !Number.isFinite(price) || price < 0) {
			res.status(400).json({ error: "price must be a non-negative number" });
			return;
		}
		const hw = await HardwareModel.findOneAndUpdate(
			{ userRef: res.locals.account._id },
			{ price },
			{ returnDocument: "after" },
		);
		if (!hw) {
			res.status(404).json({ error: "no machine yet; run the provider client to benchmark it" });
			return;
		}
		void matcher.ping();
		res.json({ hardware: serializeHardware(hw) });
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

		const existing = job.results.find((r) => r.provider.equals(me));
		if (existing?.receiptVerified) {
			res.status(409).json({ error: "your delivery is already verified" });
			return;
		}
		if (existing) existing.set({ hash, location, deliveryTime: new Date() });
		else job.results.push({ provider: me, hash, location, deliveryTime: new Date() });
		job.status = JobStatus.DELIVERY_RECEIPT_VALIDATION;
		await job.save();

		const result = job.results.find((r) => r.provider.equals(me))!;
		if (chain?.canWrite) {
			try {
				const hw = await HardwareModel.findOne({ userRef: me });
				await chain.verifyReceipt(job.onChainJobId, hw?.address ?? res.locals.wallet);
				result.receiptVerified = true;
				await job.save();
			} catch (e) {
				console.error(`Job ${job.onChainJobId}: verifyReceipt failed:`, errorMessage(e));
			}
		}
		res.status(201).json({ results: serializeResults(job).filter((r) => r.provider === String(me)) });
	});

	return router;
}
