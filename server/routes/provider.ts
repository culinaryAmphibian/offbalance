// /provider: tutorial, the provider's machine and pricing, and result delivery.
import { Router, raw } from "express";
import { randomUUID } from "node:crypto";
import { keccak256 } from "viem";
import { ArchiveError, inspectArchive, MAX_ARCHIVE_BYTES } from "../storage/archive.ts";
import { StorageError } from "../storage/results.ts";
import { decimalString } from "../models/decimal.ts";
import { hourlyPrice } from "../adapters/repository.ts";
import { requireAuth } from "../middleware/auth.ts";
import { HardwareModel, JobModel, JobStatus, TutorialModel } from "../models/index.ts";
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

export function providerRoutes({ chain, matcher, results }: Deps): Router {
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

	// Identity, assignment and phase are checked before buffering the archive.
	router.post("/provider/results/:jobId", requireAuth, async (req, res, next) => {
		const job = await loadJob(req, res);
		if (!job) return;
		const me = res.locals.account._id;
		if (!job.providers.some(p => p.equals(me))) {
			res.status(403).json({ error: "you are not assigned to this job" });
			return;
		}
		const previous = job.results.find(r => r.provider.equals(me) && r.contentVerified);
		if (!previous && job.status !== JobStatus.AWAITING_DELIVERY && job.status !== JobStatus.DELIVERY_RECEIPT_VALIDATION) {
			res.status(409).json({ error: "job is not taking deliveries" });
			return;
		}
		if (!req.is('application/x-tar')) {
			res.status(415).json({ error: "upload an application/x-tar archive; metadata-only delivery is not supported" });
			return;
		}
		if (!results) {
			res.status(503).json({ error: "result storage is disabled" });
			return;
		}
		res.locals.deliveryJob = job;
		next();
	}, raw({ type: 'application/x-tar', limit: MAX_ARCHIVE_BYTES }), async (req, res) => {
		const job: Awaited<ReturnType<typeof loadJob>> = res.locals.deliveryJob;
		if (!job || !results) return;
		const me = res.locals.account._id;
		const claimed = req.get('X-Result-Hash')?.replace(/^0x/, '').toLowerCase();
		if (!claimed || !/^[0-9a-f]{64}$/.test(claimed) || !Buffer.isBuffer(req.body)) {
			res.status(400).json({ error: "X-Result-Hash must contain the SHA256 directory digest" });
			return;
		}
		let archive: Awaited<ReturnType<typeof inspectArchive>>;
		try { archive = await inspectArchive(req.body); }
		catch (error) {
			res.status(400).json({ error: error instanceof ArchiveError ? error.message : 'Invalid result archive' });
			return;
		}
		if (archive.hash !== claimed) {
			res.status(422).json({ error: "result bytes do not match X-Result-Hash" });
			return;
		}
		const previous = job.results.find(r => r.provider.equals(me) && r.contentVerified);
		if (previous && (previous.hash !== archive.hash || previous.archiveHash !== archive.archiveHash)) {
			res.status(409).json({ error: "a different result is already stored for this provider" });
			return;
		}
		if (previous?.retainedUntil && previous.retainedUntil.getTime() <= Date.now()) {
			res.status(410).json({ error: "the stored result has expired" });
			return;
		}
		const hw = chain ? await HardwareModel.findOne({ userRef: me }) : null;
		const provider = hw?.address ?? res.locals.wallet;
		let delivered = previous?.receiptVerified ?? false;
		if (chain) {
			try {
				const state = await chain.getProviderDeliveryState(job.onChainJobId, provider);
				if (!state.revealed || !state.agreed || state.outputHash.toLowerCase() !== keccak256(`0x${archive.hash}`)) {
					res.status(422).json({ error: "uploaded output does not match the provider's agreed on-chain result" });
					return;
				}
				delivered = state.delivered;
				if (!delivered && !chain.canWrite) {
					res.status(503).json({ error: "chain receipt verification is unavailable" });
					return;
				}
			} catch {
				res.status(503).json({ error: "cannot check the agreed on-chain result" });
				return;
			}
		}
		let created = false;
		if (!previous) {
			const location = `jobs/${job.onChainJobId}/${me}/${randomUUID()}.tar`;
			try { await results.put(location, req.body); }
			catch (error) {
				res.status(error instanceof StorageError ? error.status : 503).json({ error: 'Result storage rejected the upload; retry later' });
				return;
			}
			const now = new Date();
			const result = { provider: me, hash: archive.hash, location, deliveryTime: now,
				contentVerified: true, receiptVerified: delivered, archiveHash: archive.archiveHash,
				size: req.body.length, filename: `offbalance-${job.onChainJobId}.tar`,
				retainedUntil: new Date(now.getTime() + 30 * 86400_000) };
			const open = { _id: job._id, status: { $in: [JobStatus.AWAITING_DELIVERY, JobStatus.DELIVERY_RECEIPT_VALIDATION] } };
			try {
				let saved = await JobModel.updateOne({ ...open, 'results.provider': { $ne: me } }, {
					$push: { results: result }, $set: { status: JobStatus.DELIVERY_RECEIPT_VALIDATION },
				}, { runValidators: true });
				if (!saved.matchedCount) saved = await JobModel.updateOne({ ...open,
					results: { $elemMatch: { provider: me, contentVerified: { $ne: true }, receiptVerified: { $ne: true } } },
				}, { $set: { 'results.$': result, status: JobStatus.DELIVERY_RECEIPT_VALIDATION } }, { runValidators: true });
				if (!saved.matchedCount) {
					await results.delete(location);
					res.status(409).json({ error: 'delivery changed while uploading; retry the request' });
					return;
				}
				created = true;
			} catch {
				// Do not acknowledge a receipt after an ambiguous database write.
				const persisted = await JobModel.findById(job._id).catch(() => null);
				if (persisted && !persisted.results.some(r => r.location === location)) await results.delete(location).catch(() => {});
				res.status(503).json({ error: 'could not save the delivery; retry the request' });
				return;
			}
		}
		if (chain && !delivered) {
			try { await chain.verifyReceipt(job.onChainJobId, provider); delivered = true; }
			catch { /* Keep verified bytes; an identical retry resumes the receipt. */ }
		}
		if (chain || delivered) await JobModel.updateOne({ _id: job._id, results: { $elemMatch: { provider: me, archiveHash: archive.archiveHash } } }, {
			$set: { 'results.$.receiptVerified': delivered },
		});
		const latest = await JobModel.findById(job._id);
		res.status(chain && !delivered ? 202 : created ? 201 : 200).json({ results: latest ? serializeResults(latest).filter(r => r.provider === String(me)) : [],
			receiptPending: Boolean(chain && !delivered) });
	});

	return router;
}
