import type { NextFunction, Request, Response } from "express";
import { isAddress, verifyMessage, type Hex } from "viem";
import { AccountModel, AuthNonceModel, AuthTokenModel, hashToken, loginMessage } from "../models/index.ts";

// Resolves `Authorization: Bearer <token>` to res.locals.account (and the wallet
// the token was issued to, as res.locals.wallet).
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
	const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
	if (!token) {
		res.status(401).json({ error: "missing Authorization: Bearer <token>" });
		return;
	}
	const auth = await AuthTokenModel.findOne({ tokenHash: hashToken(token) });
	const account = auth && (await AccountModel.findById(auth.account));
	if (!auth || !account || !account.walletIds.includes(auth.wallet)) {
		res.status(401).json({ error: "invalid or revoked token" });
		return;
	}
	res.locals.account = account;
	res.locals.wallet = auth.wallet;
	res.locals.tokenHash = auth.tokenHash;
	next();
}

// Checks `signature` against the outstanding nonce for `wallet`, consuming the
// nonce either way so it can't be replayed.
export async function verifyWalletSignature(wallet: string, signature: unknown): Promise<boolean> {
	if (!isAddress(wallet) || typeof signature !== "string") return false;
	const nonce = await AuthNonceModel.findOneAndDelete({ wallet: wallet.toLowerCase() });
	if (!nonce) return false;
	try {
		return await verifyMessage({
			address: wallet,
			message: loginMessage(wallet, nonce.nonce),
			signature: signature as Hex,
		});
	} catch {
		return false; // malformed signature
	}
}
