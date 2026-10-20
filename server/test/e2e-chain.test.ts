// End-to-end regression test: a real Hardhat node, the real OffBalance contract, the server's
// Chain + event handling + Orchestrator, and MongoDB. Providers and the buyer are played by
// this test; every phase transition must come from the server's orchestrator alone.
//
// Two jobs run side by side through the real (demo-sized) windows, so this takes about a minute:
//   job A: p1 and p2 agree, p3 disagrees, p1 and p2 deliver -> PAID, p3 slashed
//   job B: all three disagree                                -> NO_QUORUM, every revealer paid
//
// Needs MONGODB_URI and the blockchain/ project installed; skipped without MONGODB_URI.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
	createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, nonceManager,
	parseEther, toHex, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const uri = process.env.MONGODB_URI;
const ROOT = path.join(import.meta.dirname, "..", "..");
const BLOCKCHAIN = path.join(ROOT, "blockchain");
const PORT = Number(process.env.E2E_CHAIN_PORT ?? 8546);
const RPC_URL = `http://127.0.0.1:${PORT}`;

// Status enum indices in OffBalance.sol
const REVEAL = 3, DELIVERING = 5, PAID = 7, NO_QUORUM = 9;
// long enough for both jobs' commitments to land before the commit deadline
const EXECUTION_TIME = 10;

function devEnv(): Record<string, string> {
	return Object.fromEntries(readFileSync(path.join(ROOT, "dev.env"), "utf8").split("\n")
		.map(line => line.trim()).filter(line => line && !line.startsWith("#") && line.includes("="))
		.map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

// the provider client's commitment: keccak256(abi.encode(keccak256(output), salt))
const commitment = (output: Hex, salt: Hex) =>
	keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(output), salt]));

async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 90_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function startNode(): Promise<ChildProcess> {
	const node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { cwd: BLOCKCHAIN, detached: true, stdio: "ignore" });
	const rpc = createPublicClient({ transport: http(RPC_URL) });
	await until("hardhat node", () => rpc.getChainId().then(() => true, () => false), 60_000);
	return node;
}

test("the server alone drives jobs from commit to payout and to no-quorum", { skip: !uri, timeout: 240_000 }, async () => {
	execFileSync("npx", ["hardhat", "compile", "--quiet"], { cwd: BLOCKCHAIN, stdio: "ignore" });
	const artifact = JSON.parse(readFileSync(path.join(BLOCKCHAIN, "artifacts/contracts/OffBalance.sol/OffBalance.json"), "utf8"));
	const abi = artifact.abi as Abi;
	const env = devEnv();
	const node = await startNode();

	const { default: mongoose } = await import("mongoose");
	let stopServer = async () => {};
	try {
		const rpc = createPublicClient({ transport: http(RPC_URL) });
		const wallet = (key: string) => createWalletClient({
			account: privateKeyToAccount(key as Hex, { nonceManager }), transport: http(RPC_URL), chain: null,
		});
		const deployer = wallet(env.SERVER_PRIVATE_KEY);
		const buyer = wallet(env.BUYER_PRIVATE_KEY);
		const providers = [1, 2, 3].map(n => wallet(env[`PROVIDER_${n}_PRIVATE_KEY`]));
		const [p1, p2, p3] = providers.map(p => p.account!.address);

		const deployHash = await deployer.deployContract({ abi, bytecode: artifact.bytecode as Hex, account: deployer.account!, chain: null });
		const address = (await rpc.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address;
		const deploymentFile = path.join(mkdtempSync(path.join(tmpdir(), "offbalance-e2e-")), "localhost.json");
		writeFileSync(deploymentFile, JSON.stringify({ chainId: 31337, address, abi }));

		// the server reads its configuration at import time
		Object.assign(process.env, {
			RPC_URL, DEPLOYMENT_FILE: deploymentFile, SERVER_PRIVATE_KEY: env.SERVER_PRIVATE_KEY,
			CHAIN: "on", CHAIN_POLL_MS: "250", CHAIN_CONFIRMATIONS: "0",
		});
		const { AccountModel, JobModel, JobStatus } = await import("../models/index.ts");
		const { Chain } = await import("../services/chain.ts");
		const { handleChainEvent } = await import("../services/events.ts");
		const { Matcher } = await import("../services/matcher.ts");
		const { Orchestrator } = await import("../services/orchestrator.ts");

		await mongoose.connect(uri!, { dbName: `offbalance_e2e_test_${randomUUID().replaceAll("-", "")}` });
		await mongoose.syncIndexes();

		// the same wiring as server.ts
		const chain = await Chain.connect();
		assert.ok(chain?.canWrite, "server chain connection");
		const matcher = new Matcher(null);
		const orchestrator = new Orchestrator(chain, { log: { log() {}, warn: console.warn, error: console.error } });
		await chain.listen(async event => {
			await handleChainEvent(event, matcher);
			orchestrator.onEvent(event);
		});
		stopServer = async () => { await orchestrator.stop(); await chain.stop(); };

		const owner = await AccountModel.create({ walletIds: [buyer.account!.address.toLowerCase()] });
		for (const p of [p1, p2, p3]) await AccountModel.create({ walletIds: [p.toLowerCase()] });

		const read = <T>(functionName: string, args: unknown[]) => rpc.readContract({ address, abi, functionName, args }) as Promise<T>;
		const send = async (who: ReturnType<typeof wallet>, functionName: string, args: unknown[], value = 0n) => {
			const hash = await who.writeContract({ address, abi, functionName, args, value, account: who.account!, chain: null });
			assert.equal((await rpc.waitForTransactionReceipt({ hash })).status, "success", functionName);
		};
		const status = async (jobId: number) => (await read<readonly [number, ...bigint[]]>("getDeadlines", [BigInt(jobId)]))[0];
		const stake = await read<bigint>("STAKE", []);

		// One job: the server records it, the buyer submits it, the server assigns providers, and
		// providers commit, then reveal once the server opens the reveal phase.
		async function runJob(jobId: number, price: bigint, outputs: Hex[], deliverers: Address[]) {
			await JobModel.create({
				onChainJobId: jobId, owner: owner._id, dockerImageDigest: `example/job@sha256:${"a".repeat(64)}`,
				maxPrice: "1", runningPrice: "1", minNodesToRunOn: 3, minNodesToAgree: 2, timeWindow: EXECUTION_TIME,
			});
			await send(buyer, "submitJob", [BigInt(jobId), price, 3n, 2n, BigInt(EXECUTION_TIME), "example/job"], price);
			await chain!.assignProviders(jobId, [p1, p2, p3]);
			const salts = outputs.map((_, i) => toHex(jobId * 10 + i, { size: 32 }));
			for (const [i, provider] of providers.entries()) {
				await send(provider, "submitCommitment", [BigInt(jobId), commitment(outputs[i], salts[i])], stake);
			}
			await until(`job ${jobId} reveal phase`, async () => await status(jobId) === REVEAL);
			for (const [i, provider] of providers.entries()) {
				await send(provider, "submitReveal", [BigInt(jobId), outputs[i], salts[i]]);
			}
			const reached = await until(`job ${jobId} consensus`, async () => {
				const s = await status(jobId);
				return (s === DELIVERING || s === NO_QUORUM) && s;
			});
			if (reached === DELIVERING) {
				for (const provider of deliverers) await chain!.verifyReceipt(jobId, provider);
				await until(`job ${jobId} payout`, async () => await status(jobId) === PAID);
			}
			return reached;
		}

		const priceA = parseEther("1");
		const priceB = parseEther("0.3");
		const same = keccak256(toHex("result"));
		const [endA, endB] = await Promise.all([
			runJob(101, priceA, [same, same, keccak256(toHex("other"))], [p1, p2]),
			runJob(102, priceB, [keccak256(toHex("a")), keccak256(toHex("b")), keccak256(toHex("c"))], []),
		]);
		assert.equal(endA, DELIVERING);
		assert.equal(endB, NO_QUORUM);
		assert.equal(await status(102), NO_QUORUM);

		// job A: price + p3's slashed stake split between p1 and p2, who also get their stakes back
		// job B: no quorum, every revealer is paid a third (p1 takes the rounding dust), buyer gets nothing
		const winA = (priceA + stake) / 2n + stake;
		const thirdB = priceB / 3n, dustB = priceB - thirdB * 3n;
		const credits = await Promise.all([buyer.account!.address, p1, p2, p3].map(a => read<bigint>("credits", [a])));
		assert.deepEqual(credits, [0n, winA + thirdB + dustB + stake, winA + thirdB + stake, thirdB + stake]);

		// the database followed the chain
		await until("database statuses", async () => {
			const [a, b] = await Promise.all([101, 102].map(id => JobModel.findOne({ onChainJobId: id }).orFail()));
			return a.status === JobStatus.PAYOUT && b.status === JobStatus.NO_QUORUM;
		}, 10_000);
	} finally {
		await stopServer().catch(() => {});
		if (mongoose.connection.readyState === 1) {
			await mongoose.connection.dropDatabase();
			await mongoose.disconnect();
		}
		try { process.kill(-node.pid!, "SIGTERM"); } catch {}
	}
});
