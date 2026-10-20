// /account/:id: dashboard data and account management. `:id` may be "me".
import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth, verifyWalletSignature } from "../middleware/auth.ts";
import {
	AccountModel, AuthTokenModel, HardwareModel, JobModel, JobStatus, TERMINAL_STATUSES,
} from "../models/index.ts";
import { serializeAccount, serializeHardware, serializeJob } from "./serialize.ts";

function self(req: Request, res: Response, next: NextFunction) {
	const id = req.params.id;
	if (id !== "me" && id !== String(res.locals.account._id)) {
		res.status(403).json({ error: "you can only see your own account" });
		return;
	}
	next();
}

const RECENT = 20;

async function marketplaceStats() {
	const [providers, pricedProviders, openJobs, prices] = await Promise.all([
		HardwareModel.countDocuments(),
		HardwareModel.countDocuments({ price: { $ne: null } }),
		JobModel.countDocuments({ status: { $nin: TERMINAL_STATUSES } }),
		HardwareModel.find({ price: { $ne: null } }, "price").sort({ price: 1 }),
	]);
	const mid = Math.floor(prices.length / 2);
	const medianPrice = !prices.length ? null
		: prices.length % 2 ? prices[mid].price : (prices[mid - 1].price! + prices[mid].price!) / 2;
	return { providers, pricedProviders, openJobs, medianPrice };
}

export function accountRoutes(): Router {
	const router = Router();
	router.use("/account/:id", requireAuth, self);

	router.get("/account/:id/dashboard", async (_req, res) => {
		const account = res.locals.account;
		const active = { $nin: [...TERMINAL_STATUSES] };
		const [buyerJobs, buyerActive, providerJobs, providerActive, providerDone, hardware, marketplace] = await Promise.all([
			JobModel.find({ owner: account._id }).sort({ createdAt: -1 }).limit(RECENT),
			JobModel.countDocuments({ owner: account._id, status: active }),
			JobModel.find({ providers: account._id }).sort({ createdAt: -1 }).limit(RECENT),
			JobModel.countDocuments({ providers: account._id, status: active }),
			JobModel.countDocuments({ providers: account._id, status: JobStatus.PAYOUT }),
			HardwareModel.findOne({ userRef: account._id }),
			marketplaceStats(),
		]);
		const a = serializeAccount(account);
		res.json({
			account: { id: a.id, walletIds: a.walletIds, currentStake: a.currentStake, reputation: a.reputation, createdAt: a.createdAt },
			buyer: {
				activeJobs: buyerActive,
				completedJobs: account.completedJobs.length,
				totalSpent: a.totalSpent,
				jobs: buyerJobs.map(serializeJob),
			},
			provider: {
				activeJobs: providerActive,
				completedJobs: providerDone,
				totalEarned: a.totalEarned,
				hardware: hardware && serializeHardware(hardware),
				jobs: providerJobs.map(serializeJob),
			},
			marketplace,
		});
	});

	// link a wallet: sign the message from GET /auth/nonce?wallet=<it> with that wallet
	router.post("/account/:id/wallets", async (req, res) => {
		const { wallet, signature } = req.body ?? {};
		if (!(await verifyWalletSignature(String(wallet ?? ""), signature))) {
			res.status(401).json({ error: "bad signature, or no outstanding nonce (GET /auth/nonce first)" });
			return;
		}
		const address = String(wallet).toLowerCase();
		const account = res.locals.account;
		if (!account.walletIds.includes(address)) {
			account.walletIds.push(address);
			await account.save(); // 409 if another account has it
		}
		res.json({ account: serializeAccount(account) });
	});

	router.delete("/account/:id/wallets/:wallet", async (req, res) => {
		const account = res.locals.account;
		const address = String(req.params.wallet).toLowerCase();
		if (!account.walletIds.includes(address)) {
			res.status(404).json({ error: "that wallet isn't linked" });
			return;
		}
		if (account.walletIds.length === 1) {
			res.status(409).json({ error: "can't unlink your only wallet; delete the account instead" });
			return;
		}
		account.walletIds = account.walletIds.filter((w: string) => w !== address);
		await account.save();
		await AuthTokenModel.deleteMany({ account: account._id, wallet: address });
		res.json({ account: serializeAccount(account) });
	});

	router.delete("/account/:id", async (_req, res) => {
		const account = res.locals.account;
		const unfinished = await JobModel.countDocuments({
			$or: [{ owner: account._id }, { providers: account._id }],
			status: { $nin: TERMINAL_STATUSES },
		});
		if (unfinished) {
			res.status(409).json({ error: `you have ${unfinished} unfinished job(s)` });
			return;
		}
		await Promise.all([
			HardwareModel.deleteOne({ userRef: account._id }),
			AuthTokenModel.deleteMany({ account: account._id }),
			AccountModel.deleteOne({ _id: account._id }),
		]);
		res.status(204).end();
	});

	return router;
}
