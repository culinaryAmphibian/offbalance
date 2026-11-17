// System test: the whole stack as people run it, nothing mocked.
//   a Hardhat node + the real OffBalance, the real HTTPS server (server.ts) on MongoDB, and
//   three real provider clients (client/main.py --dev --provider 1..3) running real Docker jobs.
// The test is the buyer (HTTPS API + wallet, like the frontend) and, from scenario 3 on, a
// scripted fourth provider that misbehaves on purpose (see system/driver.ts).
//
//   1. happy path: 3 real providers agree -> PAID, the buyer downloads the result
//   2. no consensus: every provider's output is random -> NO_QUORUM, everyone refunded
//   3. a cheater: the scripted provider commits a made-up answer -> slashed, the others paid
//   4. a no-show: the scripted provider never stakes -> dropped after the 30 s window, job goes on
//   5. the buyer cancels while a no-show keeps staking open -> everyone refunded
//
// Takes about 8 minutes. Needs MONGODB_URI, a Docker daemon, blockchain/ installed, and a Python
// with the client's requirements (TEST_PYTHON, default python3). Skipped when any is missing.
//   MONGODB_URI=mongodb://127.0.0.1:27017 TEST_PYTHON=../client/.venv/bin/python npm run test:system
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, http, nonceManager, parseEther, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { devEnv, ScriptedProvider, Stack, Status, until } from "./system/driver.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");
const SERVER = path.join(ROOT, "server");
const BLOCKCHAIN = path.join(ROOT, "blockchain");
const CLIENT = path.join(ROOT, "client");
const PYTHON = process.env.TEST_PYTHON ?? "python3";
const uri = process.env.MONGODB_URI;
const PRICE = "0.01"; // ETH escrowed per job
const WINDOW = 30;    // seconds each provider gets to run the job
const JOB_TIMEOUT = 300_000;

function missing(): string | false {
	if (!uri) return "set MONGODB_URI";
	if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) return "needs a Docker daemon";
	if (!existsSync(path.join(BLOCKCHAIN, "node_modules"))) return "needs npm ci in blockchain/";
	if (spawnSync(PYTHON, ["-c", "import web3, docker, requests"], { stdio: "ignore" }).status !== 0) return `needs TEST_PYTHON (${PYTHON}) with the client's requirements`;
	return false;
}

const freePort = () => new Promise<number>((resolve, reject) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as { port: number };
		probe.close(() => resolve(port));
	}).on("error", reject);
});

describe("full stack with real provider clients and Docker", { skip: missing(), timeout: 900_000 }, () => {
	const env = devEnv(ROOT);
	const logs = mkdtempSync(path.join(tmpdir(), "offbalance-system-"));
	const processes: { name: string; child: ChildProcess }[] = [];
	let stack: Stack;
	let scripted: ScriptedProvider;
	let database = "";
	const real = [1, 2, 3].map(n => ({ token: n === 1 ? "dev" : `dev${n}`, address: env[`PROVIDER_${n}_ADDRESS`] as Address }));

	function launch(name: string, command: string, args: string[], options: { cwd: string; env?: Record<string, string> }) {
		const log = createWriteStream(path.join(logs, `${name}.log`));
		const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout!.pipe(log);
		child.stderr!.pipe(log);
		processes.push({ name, child });
		return child;
	}

	// On failure, the end of every component's log says what happened.
	function logTails(): string {
		return processes.map(({ name }) => {
			const text = existsSync(path.join(logs, `${name}.log`)) ? readFileSync(path.join(logs, `${name}.log`), "utf8") : "";
			return `----- ${name} (last 25 lines) -----\n${text.split("\n").slice(-25).join("\n")}`;
		}).join("\n");
	}
	async function scenario(fn: () => Promise<void>) {
		try { await fn(); }
		catch (error) {
			console.error(logTails());
			throw error;
		}
	}

	before(async () => {
		// chain + contract
		execFileSync("npx", ["hardhat", "compile", "--quiet"], { cwd: BLOCKCHAIN, stdio: "ignore" });
		const rpcPort = await freePort();
		const rpcUrl = `http://127.0.0.1:${rpcPort}`;
		launch("chain", "npx", ["hardhat", "node", "--port", String(rpcPort)], { cwd: BLOCKCHAIN });
		const rpc = createPublicClient({ transport: http(rpcUrl) });
		await until("hardhat node", () => rpc.getChainId().then(() => true), 60_000);
		const artifact = JSON.parse(readFileSync(path.join(BLOCKCHAIN, "artifacts/contracts/OffBalance.sol/OffBalance.json"), "utf8"));
		const deployer = createWalletClient({ account: privateKeyToAccount(env.SERVER_PRIVATE_KEY as Hex, { nonceManager }), transport: http(rpcUrl), chain: null });
		const deployed = await deployer.deployContract({ abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex, account: deployer.account!, chain: null });
		const address = (await rpc.waitForTransactionReceipt({ hash: deployed })).contractAddress!;
		const deploymentFile = path.join(logs, "localhost.json");
		writeFileSync(deploymentFile, JSON.stringify({ chainId: 31337, address, abi: artifact.abi }));

		// server: dev certificate, fresh seeded database, then server.ts
		execFileSync(process.execPath, ["scripts/dev-cert.ts"], { cwd: SERVER, stdio: "ignore" });
		const caFile = path.join(SERVER, ".local", "tls", "cert.pem");
		database = `offbalance_system_${randomUUID().replaceAll("-", "")}`;
		const mongodbUri = new URL(uri!);
		mongodbUri.pathname = `/${database}`;
		execFileSync(process.execPath, ["seed.ts"], { cwd: SERVER, env: { ...process.env, MONGODB_URI: mongodbUri.toString() }, stdio: "ignore" });
		const apiPort = await freePort();
		launch("server", process.execPath, ["server.ts"], { cwd: SERVER, env: {
			MONGODB_URI: mongodbUri.toString(), CHAIN: "on", RPC_URL: rpcUrl, DEPLOYMENT_FILE: deploymentFile,
			SERVER_PRIVATE_KEY: env.SERVER_PRIVATE_KEY, PORT: String(apiPort), HOST: "127.0.0.1",
			CHAIN_POLL_MS: "250", CHAIN_CONFIRMATIONS: "0",
			TLS_KEY_FILE: path.join(SERVER, ".local", "tls", "key.pem"), TLS_CERT_FILE: caFile,
		} });
		const apiUrl = `https://localhost:${apiPort}`;
		stack = await until("the server", () => Stack.connect({ apiUrl, rpcUrl, caFile, env }), 60_000);

		// three real provider clients, each with its own home (its job folders) on the same Docker
		for (let i = 0; i < real.length; i++) {
			launch(`client-${i + 1}`, PYTHON, ["-u", "main.py", "--dev", "--provider", String(i + 1)], { cwd: CLIENT, env: {
				OFFBALANCE_SERVER_URL: apiUrl, RPC_URL: rpcUrl, REQUESTS_CA_BUNDLE: caFile,
				HOME: mkdtempSync(path.join(tmpdir(), `offbalance-provider-${i + 1}-`)), OFFBALANCE_SKIP_GPU_BENCHMARK: "1",
			} });
		}
		// benchmarks run first, so give them time; then price them (matching needs a price)
		for (const provider of real) {
			await scenario(() => stack.waitForOnline(provider.token, 240_000).then(() => {}));
			await stack.setPrice(provider.token, 0.001);
		}
		scripted = new ScriptedProvider(stack);
	});

	after(async () => {
		scripted?.stop();
		for (const { child } of processes.reverse()) {
			try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
		}
		if (database) {
			const { default: mongoose } = await import("mongoose");
			const connection = await mongoose.createConnection(uri!, { dbName: database }).asPromise();
			await connection.dropDatabase().catch(() => {});
			await connection.close();
		}
		console.log(`system test logs: ${logs}`);
	});

	const balances = (addresses: Address[]) => Promise.all(addresses.map(a => stack.credits(a)));
	const reputations = (addresses: Address[]) => Promise.all(addresses.map(a => stack.read<number>("reputationOf", [a])));
	const assigned = async (jobId: number) => (await stack.read<Address[]>("getAssignedProviders", [BigInt(jobId)])).map(a => a.toLowerCase());

	test("1. three real providers agree: the job is paid and the buyer downloads the result", () => scenario(async () => {
		const addresses = real.map(p => p.address);
		const [before, repBefore] = [await balances([stack.buyer.account!.address, ...addresses]), await reputations(addresses)];
		const id = await stack.submitJob({ name: "happy path", command: ["sh", "-c", "echo 'result from the happy path' > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.PAID], JOB_TIMEOUT);

		const stakes = await Promise.all(addresses.map(a => stack.requiredStake(id, a)));
		const after = await balances([stack.buyer.account!.address, ...addresses]);
		assert.equal(after[0], before[0], "the buyer isn't refunded");
		const gained = addresses.map((_, i) => after[i + 1] - before[i + 1]);
		assert.equal(gained.reduce((a, b) => a + b, 0n), parseEther(PRICE) + stakes.reduce((a, b) => a + b, 0n), "the providers share the price and get their stakes back");
		for (const [i, g] of gained.entries()) assert.ok(g >= parseEther(PRICE) / 3n + stakes[i], `provider ${i + 1} got a full share`);
		assert.deepEqual(await reputations(addresses), repBefore.map(r => r + 1), "everyone gains reputation");

		const files = await stack.download(id);
		assert.equal(files.get("result.txt"), "result from the happy path\n");
		const job = await until("the server to record the payout", async () => { const j = await stack.job(id); return j.status === "PAYOUT" && j; }, 30_000);
		assert.equal(job.result.available, true);
	}));

	test("2. every provider's output differs: no consensus, buyer and stakes refunded", () => scenario(async () => {
		const addresses = real.map(p => p.address);
		const before = await balances([stack.buyer.account!.address, ...addresses]);
		const repBefore = await reputations(addresses);
		const id = await stack.submitJob({ name: "random output", command: ["sh", "-c", "head -c 16 /dev/urandom | od -An -tx1 > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.NO_QUORUM], JOB_TIMEOUT);
		const stakes = await Promise.all(addresses.map(a => stack.requiredStake(id, a)));
		const after = await balances([stack.buyer.account!.address, ...addresses]);
		assert.equal(after[0] - before[0], parseEther(PRICE), "the buyer gets the price back");
		for (const [i, stake] of stakes.entries()) assert.equal(after[i + 1] - before[i + 1], stake, `provider ${i + 1} gets its stake back`);
		assert.deepEqual(await reputations(addresses), repBefore, "nobody's reputation changes");
		assert.equal((await stack.api("GET", `/jobs/${id}/result`)).status, 404, "there's no result to download");
		await until("the server to record no quorum", async () => (await stack.job(id)).status === "NO_QUORUM", 30_000);
	}));

	test("3. a provider commits a made-up answer: it's slashed and the honest two are paid", () => scenario(async () => {
		// the scripted provider undercuts the real ones, so it's always picked
		await scripted.start("cheat", 0.0005);
		await stack.waitForOnline("dev4", 30_000);
		const id = await stack.submitJob({ name: "with a cheater", command: ["sh", "-c", "echo honest > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.COMMIT], JOB_TIMEOUT);
		const chosen = await assigned(id);
		assert.ok(chosen.includes(scripted.address.toLowerCase()), "the cheater was assigned");
		const honest = real.filter(p => chosen.includes(p.address.toLowerCase())).map(p => p.address);
		assert.equal(honest.length, 2);
		const everyone = [scripted.address, ...honest];
		const before = await balances(everyone);
		const cheaterStake = await stack.requiredStake(id, scripted.address);

		await stack.waitForStatus(id, [Status.PAID], JOB_TIMEOUT);
		const after = await balances(everyone);
		assert.equal(after[0], before[0], "the cheater gets nothing back");
		const pool = parseEther(PRICE) + cheaterStake;
		const honestGained = (after[1] - before[1]) + (after[2] - before[2]);
		const honestStakes = (await stack.requiredStake(id, honest[0])) + (await stack.requiredStake(id, honest[1]));
		assert.equal(honestGained, pool + honestStakes, "the honest providers share the price and the cheater's stake");
		assert.equal(await stack.read<number>("reputationOf", [scripted.address]), 0);
		assert.equal((await stack.download(id)).get("result.txt"), "honest\n");
	}));

	test("4. a provider never stakes: it's dropped when staking closes and the job goes on", () => scenario(async () => {
		scripted.behaviour = "no-show";
		const id = await stack.submitJob({ name: "with a no-show", command: ["sh", "-c", "echo still done > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.PROVIDER_SELECTED], 60_000);
		const pending = (await stack.read<readonly bigint[]>("getDeadlines", [BigInt(id)]))[1];
		assert.ok((await assigned(id)).includes(scripted.address.toLowerCase()), "the no-show was assigned");
		const before = await stack.credits(scripted.address);

		await stack.waitForStatus(id, [Status.COMMIT], 120_000);
		assert.ok((await stack.rpc.getBlock()).timestamp > pending, "staking stayed open for the full window");
		const kept = await assigned(id);
		assert.ok(!kept.includes(scripted.address.toLowerCase()), "the no-show was dropped");
		assert.equal(kept.length, 2);
		await stack.waitForStatus(id, [Status.PAID], JOB_TIMEOUT);
		assert.equal(await stack.credits(scripted.address), before, "a no-show has nothing to lose or gain");
		assert.equal((await stack.download(id)).get("result.txt"), "still done\n");
	}));

	test("5. the buyer cancels while staking is still open: everyone is refunded", () => scenario(async () => {
		scripted.behaviour = "no-show"; // keeps staking open for 30 s
		const buyer = stack.buyer.account!.address;
		const id = await stack.submitJob({ name: "canceled", command: ["sh", "-c", "echo never > /output/result.txt"],
			providers: 3, agree: 2, window: WINDOW, maxPrice: PRICE });
		await stack.waitForStatus(id, [Status.PROVIDER_SELECTED], 60_000);
		const chosen = await assigned(id);
		const staking = real.map(p => p.address).filter(a => chosen.includes(a.toLowerCase()));
		// wait until the real providers have staked, then cancel before the window closes
		await until("the real providers' stakes", async () => {
			const staked = await Promise.all(staking.map(a => stack.read<readonly unknown[]>("getProviderCommitment", [BigInt(id), a]).then(c => c[5] as bigint)));
			return staked.every(s => s > 0n);
		}, 25_000);
		const before = await balances([buyer, ...staking]);
		const stakes = await Promise.all(staking.map(a => stack.requiredStake(id, a)));
		await stack.cancelOnChain(id);
		assert.equal(await stack.status(id), Status.CANCELED);
		const after = await balances([buyer, ...staking]);
		assert.equal(after[0] - before[0], parseEther(PRICE), "the buyer gets the price back");
		for (const [i, stake] of stakes.entries()) assert.equal(after[i + 1] - before[i + 1], stake, "stakes come back");
		await until("the server to record the cancellation", async () => (await stack.job(id)).status === "CANCELED", 30_000);
	}));
});
