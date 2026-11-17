// Authentication against odd and hostile input, on the real routes and MongoDB: malformed and
// oversized Authorization headers must be a 401 (never a 500), nonces are single-use and the
// newest one wins, wallet addresses are case-insensitive, and an expired nonce is refused.
//
// Skipped without MONGODB_URI.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import mongoose from "mongoose";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { AccountModel, AuthNonceModel, AuthTokenModel, NONCE_TTL_S, hashToken } from "../models/index.ts";
import { Builder } from "../services/builder.ts";
import { Matcher } from "../services/matcher.ts";

const uri = process.env.MONGODB_URI;

describe("authentication hardening", { skip: !uri && "set MONGODB_URI to run" }, () => {
	let server: Server;
	let port = 0;

	// raw HTTP, so headers that fetch() would refuse to send can be tested. (Trailing whitespace in a
	// header value is stripped by HTTP itself, so "Bearer token " is the same as "Bearer token".)
	const raw = (path: string, headers: Record<string, string>, method = "GET", body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) } }, res => {
			let text = "";
			res.on("data", chunk => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
		});
		req.on("error", reject);
		req.end(body);
	});
	const json = async (path: string, body: unknown) => {
		const res = await raw(path, {}, "POST", JSON.stringify(body));
		return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
	};
	const nonce = async (wallet: string) => JSON.parse((await raw(`/auth/nonce?wallet=${wallet}`, {})).body).message as string;

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-auth-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		await AuthNonceModel.init();
		const account = await AccountModel.create({ walletIds: [`0x${"1".repeat(40)}`] });
		await AuthTokenModel.create({ tokenHash: hashToken("good-token"), account: account._id, wallet: `0x${"1".repeat(40)}` });
		server = createApp({ chain: null, matcher: new Matcher(null), builder: new Builder() }, { log: false }).listen(0, "127.0.0.1");
		await new Promise(resolve => server.once("listening", resolve));
		port = (server.address() as { port: number }).port;
	});
	after(async () => {
		if (server) await new Promise(resolve => server.close(resolve));
		if (mongoose.connection.readyState === 1) {
			await mongoose.connection.dropDatabase();
			await disconnectDB();
		}
	});

	test("the good token works, so the cases below fail for the right reason", async () => {
		assert.equal((await raw("/jobs", { Authorization: "Bearer good-token" })).status, 200);
	});

	test("malformed, foreign and oversized Authorization headers are a 401, never a server error", async () => {
		const headers = [
			"", "Bearer", "Bearer ", "Bearer  ", "Basic Z29vZC10b2tlbjo=", "Token good-token", "good-token",
			"bearer good-token",                 // the scheme is case-sensitive here
			"Bearer good-token, Bearer other",   // two credentials in one header
			`Bearer ${"x".repeat(8 * 1024)}`,    // 8 KB, under Node's 16 KB header limit
			"Bearer éè",               // latin-1 bytes
		];
		for (const value of headers) {
			const res = await raw("/jobs", value ? { Authorization: value } : {});
			assert.equal(res.status, 401, JSON.stringify(value.slice(0, 40)));
			assert.match(JSON.parse(res.body).error, /token/i);
		}
	});

	test("a header over Node's limit is refused before it reaches the app", async () => {
		const res = await raw("/jobs", { Authorization: `Bearer ${"x".repeat(32 * 1024)}` });
		assert.equal(res.status, 431);
	});

	test("asking for a new nonce replaces the old one", async () => {
		const wallet = privateKeyToAccount(generatePrivateKey());
		const first = await nonce(wallet.address);
		const second = await nonce(wallet.address);
		assert.notEqual(first, second);
		assert.equal((await json("/auth", { wallet: wallet.address, signature: await wallet.signMessage({ message: first }) })).status, 401);
		// the failed attempt used up the outstanding nonce too
		assert.equal((await json("/auth", { wallet: wallet.address, signature: await wallet.signMessage({ message: second }) })).status, 401);
		const third = await nonce(wallet.address);
		assert.equal((await json("/auth", { wallet: wallet.address, signature: await wallet.signMessage({ message: third }) })).status, 201);
	});

	// wallets send checksummed or lowercase addresses (an all-uppercase one isn't accepted)
	test("the wallet's letter case doesn't matter: one account per wallet", async () => {
		const wallet = privateKeyToAccount(generatePrivateKey());
		const signIn = async (address: string) => {
			const message = await nonce(address);
			return json("/auth", { wallet: address, signature: await wallet.signMessage({ message }) });
		};
		const lower = await signIn(wallet.address.toLowerCase());
		const checksummed = await signIn(wallet.address);
		assert.equal(lower.status, 201);
		assert.equal(checksummed.status, 201);
		assert.equal(lower.body.accountId, checksummed.body.accountId);
	});

	test("a signature for another wallet's nonce doesn't sign in either wallet", async () => {
		const [a, b] = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
		const forA = await nonce(a.address);
		await nonce(b.address);
		const res = await json("/auth", { wallet: b.address, signature: await a.signMessage({ message: forA }) });
		assert.equal(res.status, 401);
		assert.equal(await AccountModel.countDocuments({ walletIds: { $in: [a.address.toLowerCase(), b.address.toLowerCase()] } }), 0);
	});

	// verifyWalletSignature doesn't check the nonce's age; it relies on MongoDB's TTL monitor,
	// which only runs about once a minute, so a nonce can still sign in after it has expired.
	test("a nonce older than its lifetime is refused even before MongoDB removes it",
		{ todo: "middleware/auth.ts: check createdAt against NONCE_TTL_S in verifyWalletSignature" }, async () => {
			const wallet = privateKeyToAccount(generatePrivateKey());
			const message = await nonce(wallet.address);
			await AuthNonceModel.updateOne({ wallet: wallet.address.toLowerCase() },
				{ createdAt: new Date(Date.now() - (NONCE_TTL_S + 30) * 1000) });
			const res = await json("/auth", { wallet: wallet.address, signature: await wallet.signMessage({ message }) });
			assert.equal(res.status, 401);
		});
});
