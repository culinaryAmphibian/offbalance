// Fault injection, end to end: a real Hardhat node and contract, the server's Chain + event
// handling + Orchestrator + HTTP API, and a MongoDB of its own in a throwaway Docker container
// (so it can be stopped without touching anyone's database).
//   1. the chain's RPC goes dark mid-job (a TCP proxy between the server and the node is cut)
//      across the commit deadline: when it comes back, the server advances the job to payout
//   2. MongoDB stops mid-job, across the reveal deadline: when it comes back, the event monitor
//      replays what it missed, the job is paid, and nothing is recorded twice
//   3. while MongoDB is down, API requests fail fast with a 5xx instead of hanging, the process
//      stays up, and the same requests work again once MongoDB is back
// Providers and the buyer are played by this test and talk to the node directly.
//
// Needs Docker, blockchain/ installed, and the mongo image (pulled on first run). About 4 minutes.
// Skipped without Docker.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, nonceManager,
	parseEther, toHex, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.join(import.meta.dirname, "..", "..");
const BLOCKCHAIN = path.join(ROOT, "blockchain");
const MONGO_IMAGE = "mongo:8.2";
const COMMIT = 3, REVEAL = 4, PAID = 8;
const EXECUTION_TIME = 10;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const freePort = () => new Promise<number>((resolve, reject) => {
	const probe = createTcpServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as { port: number };
		probe.close(() => resolve(port));
	}).on("error", reject);
});

async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs: number): Promise<T> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const value = await check().catch(() => undefined);
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

// A TCP proxy that can be cut (existing connections dropped, new ones refused) and restored.
class CuttableProxy {
	private server?: TcpServer;
	private sockets = new Set<Socket>();
	readonly port: number;
	private readonly target: number;
	constructor(port: number, target: number) {
		this.port = port;
		this.target = target;
	}
	async open(): Promise<void> {
		this.server = createTcpServer(client => {
			const upstream = connect(this.target, "127.0.0.1");
			for (const s of [client, upstream]) { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); s.on("error", () => {}); }
			client.pipe(upstream).pipe(client);
		});
		await new Promise<void>(resolve => this.server!.listen(this.port, "127.0.0.1", resolve));
	}
	async cut(): Promise<void> {
		for (const s of this.sockets) s.destroy();
		await new Promise<void>(resolve => this.server!.close(() => resolve()));
	}
}

describe("the server survives chain and database outages", { skip: !hasDocker && "needs Docker", timeout: 600_000 }, () => {
	const container = `offbalance-outage-mongo-${process.pid}`;
	let node: ChildProcess;
	let proxy: CuttableProxy;
	let stopServer = async () => {};
	let api: Server;
	let apiBase = "";
	let mongoose: typeof import("mongoose").default;
	let models: typeof import("../models/index.ts");
	let rpc: ReturnType<typeof createPublicClient>;
	let abi: Abi;
	let address: Address;
	let nextJob = 1;
	const logs: string[] = [];
	const wallets: Record<string, ReturnType<typeof createWalletClient>> = {};

	const read = <T>(functionName: string, args: unknown[]) => rpc.readContract({ address, abi, functionName, args }) as Promise<T>;
	const send = async (who: string, functionName: string, args: unknown[], value = 0n) => {
		const w = wallets[who];
		const hash = await w.writeContract({ address, abi, functionName, args, value, account: w.account!, chain: null });
		assert.equal((await rpc.waitForTransactionReceipt({ hash })).status, "success", `${who} ${functionName}`);
	};
	const status = (jobId: number) => read<number>("getJobStatus", [BigInt(jobId)]);
	const deadlines = (jobId: number) => read<readonly [number, bigint, bigint, bigint, bigint]>("getDeadlines", [BigInt(jobId)]);
	const commitment = (output: Hex, salt: Hex) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(output), salt]));
	const chainTime = async () => (await rpc.getBlock()).timestamp;
	const salt = (jobId: number, who: string) => toHex(`${jobId}${who}`, { size: 32 });
	const RESULT = keccak256(toHex("the result"));

	// A job for p1 and p2 (both must agree), saved, submitted, assigned by the server, staked.
	async function jobInCommit(): Promise<number> {
		const jobId = nextJob++;
		const owner = await models.AccountModel.findOne({ walletIds: wallets.buyer.account!.address.toLowerCase() }).orFail();
		await models.JobModel.create({ onChainJobId: jobId, owner: owner._id, dockerImageDigest: `example/job@sha256:${"a".repeat(64)}`,
			maxPrice: "1", runningPrice: "1", minNodesToRunOn: 2, minNodesToAgree: 2, timeWindow: EXECUTION_TIME });
		const price = parseEther("0.2");
		await send("buyer", "submitJob", [price, 2n, 2n, BigInt(EXECUTION_TIME), "example/job"], price);
		await chain!.assignProviders(jobId, [wallets.p1.account!.address, wallets.p2.account!.address]);
		for (const who of ["p1", "p2"]) {
			const required = (await read<readonly unknown[]>("getProviderCommitment", [BigInt(jobId), wallets[who].account!.address]))[4] as bigint;
			await send(who, "submitStake", [BigInt(jobId)], required);
		}
		await until(`job ${jobId} commit phase`, async () => await status(jobId) === COMMIT, 30_000);
		return jobId;
	}
	let chain: Awaited<ReturnType<typeof import("../services/chain.ts").Chain.connect>>;

	before(async () => {
		// MongoDB of our own
		const mongoPort = await freePort();
		docker("run", "-d", "--name", container, "-p", `127.0.0.1:${mongoPort}:27017`, MONGO_IMAGE);
		const mongoUri = `mongodb://127.0.0.1:${mongoPort}/offbalance_outage`;
		await until("MongoDB", async () => docker("exec", container, "mongosh", "--quiet", "--eval", "db.runCommand({ping:1}).ok") === "1", 60_000);

		// chain, contract, and the proxy the server reaches the node through
		execFileSync("npx", ["hardhat", "compile", "--quiet"], { cwd: BLOCKCHAIN, stdio: "ignore" });
		const nodePort = await freePort();
		node = spawn("npx", ["hardhat", "node", "--port", String(nodePort)], { cwd: BLOCKCHAIN, detached: true, stdio: "ignore" });
		const nodeUrl = `http://127.0.0.1:${nodePort}`;
		rpc = createPublicClient({ transport: http(nodeUrl) });
		await until("hardhat node", () => rpc.getChainId().then(() => true), 60_000);
		proxy = new CuttableProxy(await freePort(), nodePort);
		await proxy.open();

		const env = Object.fromEntries(readFileSync(path.join(ROOT, "dev.env"), "utf8").split("\n").map(l => l.trim())
			.filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		const wallet = (key: string) => createWalletClient({ account: privateKeyToAccount(key as Hex, { nonceManager }), transport: http(nodeUrl), chain: null });
		Object.assign(wallets, { deployer: wallet(env.SERVER_PRIVATE_KEY), buyer: wallet(env.BUYER_PRIVATE_KEY),
			p1: wallet(env.PROVIDER_1_PRIVATE_KEY), p2: wallet(env.PROVIDER_2_PRIVATE_KEY) });
		const artifact = JSON.parse(readFileSync(path.join(BLOCKCHAIN, "artifacts/contracts/OffBalance.sol/OffBalance.json"), "utf8"));
		abi = artifact.abi;
		const hash = await wallets.deployer.deployContract({ abi, bytecode: artifact.bytecode, account: wallets.deployer.account!, chain: null });
		address = (await rpc.waitForTransactionReceipt({ hash })).contractAddress as Address;
		const deploymentFile = path.join(mkdtempSync(path.join(tmpdir(), "offbalance-outage-")), "localhost.json");
		writeFileSync(deploymentFile, JSON.stringify({ chainId: 31337, address, abi }));

		// the server, wired like server.ts, reaching the chain through the proxy
		Object.assign(process.env, { RPC_URL: `http://127.0.0.1:${proxy.port}`, DEPLOYMENT_FILE: deploymentFile,
			SERVER_PRIVATE_KEY: env.SERVER_PRIVATE_KEY, CHAIN: "on", CHAIN_POLL_MS: "250", CHAIN_CONFIRMATIONS: "0" });
		mongoose = (await import("mongoose")).default;
		models = await import("../models/index.ts");
		const { Chain } = await import("../services/chain.ts");
		const { handleChainEvent } = await import("../services/events.ts");
		const { Matcher } = await import("../services/matcher.ts");
		const { Orchestrator } = await import("../services/orchestrator.ts");
		const { createApp } = await import("../app.ts");
		const { Builder } = await import("../services/builder.ts");
		await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5_000 });
		await mongoose.syncIndexes();
		chain = await Chain.connect();
		assert.ok(chain?.canWrite);
		const matcher = new Matcher(null);
		const quiet = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (...m: unknown[]) => logs.push(m.join(" ")) };
		const orchestrator = new Orchestrator(chain, { log: quiet });
		// before anything that can fail, so after() always stops the poll loop and the process can exit
		stopServer = async () => { await orchestrator.stop(); await chain!.stop(); };
		await chain.listen(async event => {
			await handleChainEvent(event, matcher);
			orchestrator.onEvent(event);
		});
		api = createApp({ chain, matcher, builder: new Builder() }, { log: false }).listen(0, "127.0.0.1");
		await new Promise(resolve => api.once("listening", resolve));
		apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

		const buyer = await models.AccountModel.create({ walletIds: [wallets.buyer.account!.address.toLowerCase()] });
		await models.AuthTokenModel.create({ tokenHash: models.hashToken("buyer-token"), account: buyer._id, wallet: wallets.buyer.account!.address.toLowerCase() });
		for (const w of ["p1", "p2"]) await models.AccountModel.create({ walletIds: [wallets[w].account!.address.toLowerCase()] });
	});

	after(async () => {
		await stopServer().catch(() => {});
		if (api) await new Promise(resolve => api.close(resolve));
		await proxy?.cut().catch(() => {});
		await mongoose?.disconnect().catch(() => {});
		try { process.kill(-node.pid!, "SIGTERM"); } catch { /* gone */ }
		spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
	});

	test("the chain's RPC goes dark across the commit deadline: the job still reaches payout", async () => {
		const jobId = await jobInCommit();
		await send("p1", "submitCommitment", [BigInt(jobId), commitment(RESULT, salt(jobId, "p1"))]);
		await send("p2", "submitCommitment", [BigInt(jobId), commitment(RESULT, salt(jobId, "p2"))]);
		const [, , commitDeadline] = await deadlines(jobId);
		// cut only once the server has handled COMMIT_PHASE_START, so its startRevealPhase timer is
		// already set and fires during the outage (otherwise it would just catch up afterwards)
		await until("the server to record the commit phase", async () =>
			(await models.JobModel.findOne({ onChainJobId: jobId }))?.status === models.JobStatus.COMMIT_PHASE, 30_000);

		await proxy.cut();
		// stay dark until well after the deadline, so the server's startRevealPhase fails and retries
		await until("chain time past the commit deadline", async () => await chainTime() > commitDeadline + 8n, 60_000);
		assert.equal(await status(jobId), COMMIT, "nothing can advance the job while the server is cut off");
		await proxy.open();

		await until(`job ${jobId} reveal phase after the outage`, async () => await status(jobId) === REVEAL, 60_000);
		assert.ok(logs.some(l => /startRevealPhase failed .*retrying|reading deadlines failed/.test(l)), `the orchestrator saw the outage and retried; its log:\n${logs.join("\n")}`);
		await send("p1", "submitReveal", [BigInt(jobId), RESULT, salt(jobId, "p1")]);
		await send("p2", "submitReveal", [BigInt(jobId), RESULT, salt(jobId, "p2")]);
		await until(`job ${jobId} payout`, async () => await status(jobId) === PAID, 120_000);
		await until("the database to follow", async () => (await models.JobModel.findOne({ onChainJobId: jobId }))?.status === models.JobStatus.PAYOUT, 30_000);
	});

	test("MongoDB stops across the reveal deadline: the job is paid and recorded once", async () => {
		const jobId = await jobInCommit();
		await send("p1", "submitCommitment", [BigInt(jobId), commitment(RESULT, salt(jobId, "p1"))]);
		await send("p2", "submitCommitment", [BigInt(jobId), commitment(RESULT, salt(jobId, "p2"))]);
		await until(`job ${jobId} reveal phase`, async () => await status(jobId) === REVEAL, 60_000);
		await send("p1", "submitReveal", [BigInt(jobId), RESULT, salt(jobId, "p1")]);
		await send("p2", "submitReveal", [BigInt(jobId), RESULT, salt(jobId, "p2")]);
		const [, , , revealDeadline] = await deadlines(jobId);

		docker("stop", container);
		await until("chain time past the reveal deadline", async () => await chainTime() > revealDeadline + 5n, 60_000);
		docker("start", container);

		await until(`job ${jobId} payout after MongoDB came back`, async () => await status(jobId) === PAID, 180_000);
		const saved = await until("the database to catch up", async () => {
			const job = await models.JobModel.findOne({ onChainJobId: jobId });
			return job?.status === models.JobStatus.PAYOUT && job;
		}, 60_000);
		assert.equal(saved.payouts.length, 2, "each provider's payout is recorded exactly once");
		assert.equal(new Set(saved.payouts.map(p => String(p.provider))).size, 2);
	});

	test("while MongoDB is down the API fails fast with a 5xx, and recovers when it's back", async () => {
		const get = async () => {
			const started = Date.now();
			const res = await fetch(`${apiBase}/jobs`, { headers: { Authorization: "Bearer buyer-token" }, signal: AbortSignal.timeout(30_000) });
			return { status: res.status, ms: Date.now() - started };
		};
		assert.equal((await get()).status, 200);
		docker("stop", container);
		try {
			const down = await get();
			assert.ok(down.status >= 500 && down.status < 600, `got ${down.status}`);
			assert.ok(down.ms < 15_000, `the request hung for ${down.ms} ms`);
			const config = await fetch(`${apiBase}/config`);
			assert.equal(config.status, 200, "routes that don't need the database keep working");
		} finally {
			docker("start", container);
		}
		await until("the API to recover", async () => (await get()).status === 200, 60_000);
	});
});
