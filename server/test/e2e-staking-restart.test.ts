// End-to-end, like e2e-chain.test.ts (a real Hardhat node, the real contract, the server's Chain +
// event handling + Orchestrator, and MongoDB), for the cases that one doesn't cover:
//   - a provider that never stakes is dropped when the staking window closes, and the job goes on
//   - too few providers stake: the job ends in NO_QUORUM and everyone is refunded
//   - the server restarts while a job is in progress (TESTING_PLAN.md B5)
// Every phase transition must come from the server. This takes about two minutes, because the
// staking window is 30 seconds of real time.
//
// Needs MONGODB_URI and the blockchain/ project installed; skipped without MONGODB_URI.
import { after, before, describe, test } from "node:test";
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
const PORT = Number(process.env.E2E_RESTART_CHAIN_PORT ?? 8547);
const RPC_URL = `http://127.0.0.1:${PORT}`;

// Status enum indices in OffBalance.sol
const COMMIT = 3, REVEAL = 4, PAID = 8, NO_QUORUM = 10;
const EXECUTION_TIME = 10;

function devEnv(): Record<string, string> {
	return Object.fromEntries(readFileSync(path.join(ROOT, "dev.env"), "utf8").split("\n")
		.map(line => line.trim()).filter(line => line && !line.startsWith("#") && line.includes("="))
		.map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

const commitment = (output: Hex, salt: Hex) =>
	keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(output), salt]));

async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 120_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("the server drives staking and survives restarts", { skip: !uri && "set MONGODB_URI to run", timeout: 400_000 }, () => {
	let node: ChildProcess;
	let mongoose: typeof import("mongoose").default;
	let stopServer = async () => {};
	// set up in before()
	let rpc: ReturnType<typeof createPublicClient>;
	let abi: Abi;
	let address: Address;
	let p1: Address, p2: Address, p3: Address;
	let wallets: Record<string, ReturnType<typeof createWalletClient>>;
	let startServer: () => Promise<Awaited<ReturnType<typeof import("../services/chain.ts").Chain.connect>>>;
	let createJob: (jobId: number, k: number, providers: number) => Promise<void>;
	let checkpointBlock: () => Promise<number>;

	const read = <T>(functionName: string, args: unknown[]) => rpc.readContract({ address, abi, functionName, args }) as Promise<T>;
	const send = async (who: string, functionName: string, args: unknown[], value = 0n) => {
		const w = wallets[who];
		const hash = await w.writeContract({ address, abi, functionName, args, value, account: w.account!, chain: null });
		assert.equal((await rpc.waitForTransactionReceipt({ hash })).status, "success", `${who} ${functionName}`);
	};
	const status = async (jobId: number) => (await read<readonly [number, ...bigint[]]>("getDeadlines", [BigInt(jobId)]))[0];
	const deadlines = (jobId: number) => read<readonly [number, bigint, bigint, bigint, bigint]>("getDeadlines", [BigInt(jobId)]);
	const stake = async (who: "p1" | "p2" | "p3", jobId: number) => {
		const provider = { p1, p2, p3 }[who];
		const required = (await read<readonly [Hex, Hex, boolean, boolean, bigint, bigint]>("getProviderCommitment", [BigInt(jobId), provider]))[4];
		await send(who, "submitStake", [BigInt(jobId)], required);
		return required;
	};
	const salt = (jobId: number, who: string) => toHex(`${jobId}-${who}`, { size: 32 });

	before(async () => {
		execFileSync("npx", ["hardhat", "compile", "--quiet"], { cwd: BLOCKCHAIN, stdio: "ignore" });
		const artifact = JSON.parse(readFileSync(path.join(BLOCKCHAIN, "artifacts/contracts/OffBalance.sol/OffBalance.json"), "utf8"));
		abi = artifact.abi as Abi;
		const env = devEnv();
		node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { cwd: BLOCKCHAIN, detached: true, stdio: "ignore" });
		rpc = createPublicClient({ transport: http(RPC_URL) });
		await until("hardhat node", () => rpc.getChainId().then(() => true, () => false), 60_000);

		const wallet = (key: string) => createWalletClient({
			account: privateKeyToAccount(key as Hex, { nonceManager }), transport: http(RPC_URL), chain: null,
		});
		wallets = {
			deployer: wallet(env.SERVER_PRIVATE_KEY), buyer: wallet(env.BUYER_PRIVATE_KEY),
			p1: wallet(env.PROVIDER_1_PRIVATE_KEY), p2: wallet(env.PROVIDER_2_PRIVATE_KEY), p3: wallet(env.PROVIDER_3_PRIVATE_KEY),
		};
		[p1, p2, p3] = ["p1", "p2", "p3"].map(w => wallets[w].account!.address);
		const deployer = wallets.deployer;
		const deployHash = await deployer.deployContract({ abi, bytecode: artifact.bytecode as Hex, account: deployer.account!, chain: null });
		address = (await rpc.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address;
		const deploymentFile = path.join(mkdtempSync(path.join(tmpdir(), "offbalance-e2e-restart-")), "localhost.json");
		writeFileSync(deploymentFile, JSON.stringify({ chainId: 31337, address, abi }));

		// the server reads its configuration at import time
		Object.assign(process.env, {
			RPC_URL, DEPLOYMENT_FILE: deploymentFile, SERVER_PRIVATE_KEY: env.SERVER_PRIVATE_KEY,
			CHAIN: "on", CHAIN_POLL_MS: "250", CHAIN_CONFIRMATIONS: "0",
		});
		mongoose = (await import("mongoose")).default;
		const { AccountModel, JobModel } = await import("../models/index.ts");
		const { Chain } = await import("../services/chain.ts");
		const { handleChainEvent } = await import("../services/events.ts");
		const { Matcher } = await import("../services/matcher.ts");
		const { Orchestrator } = await import("../services/orchestrator.ts");
		await mongoose.connect(uri!, { dbName: `offbalance_e2e_restart_${randomUUID().replaceAll("-", "")}` });
		await mongoose.syncIndexes();
		const { MongoCheckpointStore, checkpointNamespace } = await import("../adapters/checkpoints.ts");
		const checkpoint = new MongoCheckpointStore(checkpointNamespace(31337, address));
		checkpointBlock = async () => (await checkpoint.load())?.blockNumber ?? -1;
		const { unfinishedPhaseJobIds } = await import("../services/phase-recovery.ts");

		// the same wiring as server.ts; calling it again is a server restart (same database)
		startServer = async () => {
			const chain = await Chain.connect();
			assert.ok(chain?.canWrite, "server chain connection");
			const matcher = new Matcher(null);
			const orchestrator = new Orchestrator(chain, { log: { log() {}, warn() {}, error: console.error } });
			// Before anything that can fail (recovery reads MongoDB): if this start fails halfway,
			// after() must still stop this instance's poll loop, or the test process never exits.
			stopServer = async () => { await orchestrator.stop(); await chain.stop(); };
			await chain.listen(async event => {
				await handleChainEvent(event, matcher);
				orchestrator.onEvent(event);
			});
			await orchestrator.recover(await unfinishedPhaseJobIds());
			return chain;
		};
		const owner = await AccountModel.create({ walletIds: [wallets.buyer.account!.address.toLowerCase()] });
		for (const p of [p1, p2, p3]) await AccountModel.create({ walletIds: [p.toLowerCase()] });
		createJob = async (jobId, k, providers) => {
			await JobModel.create({
				onChainJobId: jobId, owner: owner._id, dockerImageDigest: `example/job@sha256:${"a".repeat(64)}`,
				maxPrice: "1", runningPrice: "1", minNodesToRunOn: providers, minNodesToAgree: k, timeWindow: EXECUTION_TIME,
			});
		};
	});

	after(async () => {
		await stopServer().catch(() => {});
		// Always disconnect, even if MongoDB went away mid-test: an open client's heartbeat timer keeps the process alive.
		if (mongoose?.connection.readyState === 1) await mongoose.connection.dropDatabase().catch(() => {});
		await mongoose?.disconnect().catch(() => {});
		try { process.kill(-node.pid!, "SIGTERM"); } catch {}
	});

	test("a provider that never stakes is dropped and the job goes on; too few stakers refunds everyone", async () => {
		const chain = (await startServer())!;
		const priceA = parseEther("0.6"), priceB = parseEther("0.2");
		// job 1: k = 2 of 3, p3 never stakes. job 2: k = 2 of 2, p2 never stakes.
		await createJob(1, 2, 3);
		await send("buyer", "submitJob", [priceA, 2n, 3n, BigInt(EXECUTION_TIME), "example/job"], priceA);
		await chain.assignProviders(1, [p1, p2, p3]);
		await createJob(2, 2, 2);
		await send("buyer", "submitJob", [priceB, 2n, 2n, BigInt(EXECUTION_TIME), "example/job"], priceB);
		await chain.assignProviders(2, [p1, p2]);

		const stake1 = await stake("p1", 1);
		await stake("p2", 1);
		const stake2 = await stake("p1", 2);

		// nobody else stakes, so the server has to wait out the 30 s window to close staking
		const [, pending] = await deadlines(1);
		const job2 = await until("job 2 ends for lack of stakers", async () => await status(2) === NO_QUORUM, 90_000);
		assert.ok(job2);
		await until("job 1 commit phase", async () => await status(1) === COMMIT, 90_000);
		const now = (await rpc.getBlock()).timestamp;
		assert.ok(now > pending, "staking closed only after the window");
		assert.deepEqual((await read<Address[]>("getAssignedProviders", [1n])).map(a => a.toLowerCase()).sort(),
			[p1, p2].map(a => a.toLowerCase()).sort(), "p3 was dropped");

		const result = keccak256(toHex("result"));
		await send("p1", "submitCommitment", [1n, commitment(result, salt(1, "p1"))]);
		await send("p2", "submitCommitment", [1n, commitment(result, salt(1, "p2"))]);
		await until("job 1 reveal phase", async () => await status(1) === REVEAL);
		await send("p1", "submitReveal", [1n, result, salt(1, "p1")]);
		await send("p2", "submitReveal", [1n, result, salt(1, "p2")]);
		await until("job 1 payout", async () => await status(1) === PAID, 120_000);

		const credits = await Promise.all([wallets.buyer.account!.address, p1, p2, p3].map(a => read<bigint>("credits", [a])));
		const share = priceA / 2n;
		assert.equal(credits[0], priceB, "job 2's buyer refunded");
		assert.equal(credits[1], share + (priceA - share * 2n) + stake1 + stake2, "p1: half of job 1 + its stake, and job 2's stake back");
		assert.equal(credits[2], share + stake1, "p2: half of job 1 + its stake");
		assert.equal(credits[3], 0n, "p3 never staked and gets nothing");
		assert.equal(await read<number>("reputationOf", [p3]), 0, "not staking costs no reputation");
	});

	test("a job in progress when the server restarts still finishes", async () => {
		await stopServer();
		const chain = (await startServer())!;
		const price = parseEther("0.4");
		await createJob(3, 2, 2);
		await send("buyer", "submitJob", [price, 2n, 2n, BigInt(EXECUTION_TIME), "example/job"], price);
		await chain.assignProviders(3, [p1, p2]);
		await stake("p1", 3);
		await stake("p2", 3);
		await until("job 3 commit phase", async () => await status(3) === COMMIT, 30_000);
		// The restart has to come after the server has handled COMMIT_PHASE_START (the database
		// shows it) and saved its checkpoint past that block; otherwise the restarted server just
		// sees the event for the first time and the test proves nothing.
		const { JobModel, JobStatus } = await import("../models/index.ts");
		await until("the server to record job 3's commit phase", async () =>
			(await JobModel.findOne({ onChainJobId: 3 }))?.status === JobStatus.COMMIT_PHASE, 30_000);
		const logs = await rpc.getContractEvents({
			address, abi, eventName: "COMMIT_PHASE_START", args: { jobId: 3n }, fromBlock: 0n, toBlock: "latest",
		});
		assert.equal(logs.length, 1);
		await until("the commit phase event to be checkpointed", async () =>
			await checkpointBlock() >= Number(logs[0].blockNumber), 30_000);

		// restart the server mid-commit, then let the commit deadline pass
		await stopServer();
		await startServer();
		const result = keccak256(toHex("result 3"));
		await send("p1", "submitCommitment", [3n, commitment(result, salt(3, "p1"))]);
		await send("p2", "submitCommitment", [3n, commitment(result, salt(3, "p2"))]);
		await until("job 3 reveal phase after the restart", async () => await status(3) === REVEAL, (EXECUTION_TIME + 20) * 1000);
		await send("p1", "submitReveal", [3n, result, salt(3, "p1")]);
		await send("p2", "submitReveal", [3n, result, salt(3, "p2")]);
		await until("job 3 payout", async () => await status(3) === PAID, 90_000);
	});
});
