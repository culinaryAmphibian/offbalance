// /auth: sign in with a wallet. The returned token is both the web app's session
// and the provider client's API key.
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { isAddress } from "viem";
import { requireAuth, verifyWalletSignature } from "../middleware/auth.ts";
import { AccountModel, AuthNonceModel, AuthTokenModel, hashToken, loginMessage, newToken } from "../models/index.ts";

export function authRoutes(): Router {
	const router = Router();

	// step 1: get a message for the wallet to sign (also used to link a wallet)
	router.get("/auth/nonce", async (req, res) => {
		const wallet = String(req.query.wallet ?? "");
		if (!isAddress(wallet)) {
			res.status(400).json({ error: "wallet must be an address" });
			return;
		}
		const nonce = randomBytes(16).toString("hex");
		await AuthNonceModel.findOneAndUpdate(
			{ wallet: wallet.toLowerCase() },
			{ nonce, createdAt: new Date() },
			{ upsert: true },
		);
		res.json({ message: loginMessage(wallet, nonce), wallet: wallet.toLowerCase() });
	});

	// step 2: send the signature back; a new wallet signs up
	router.post("/auth", async (req, res) => {
		const { wallet, signature } = req.body ?? {};
		if (!(await verifyWalletSignature(String(wallet ?? ""), signature))) {
			res.status(401).json({ error: "bad signature, or no outstanding nonce (GET /auth/nonce first)" });
			return;
		}
		const address = String(wallet).toLowerCase();
		const account = await AccountModel.findOne({ walletIds: address }) ??
			await AccountModel.create({ walletIds: [address] });

		const token = newToken();
		await AuthTokenModel.create({ tokenHash: hashToken(token), account: account._id, wallet: address });
		res.status(201).json({ token, accountId: String(account._id), wallet: address });
	});

	router.post("/auth/logout", requireAuth, async (_req, res) => {
		await AuthTokenModel.deleteOne({ tokenHash: res.locals.tokenHash });
		res.status(204).end();
	});

	return router;
}
