// Starts the whole stack locally for the system tests: a Hardhat node + the real OffBalance, the
// real HTTPS server (server.ts) on a fresh seeded MongoDB database, and N real provider clients
// (client/main.py --dev --provider 1..N) running real Docker jobs, each priced and online.
// Used by system-full-stack.test.ts and soak.ts. Every component logs to its own file in `logs`.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, http, nonceManager, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { devEnv, Stack, until } from "./driver.ts";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SERVER = path.join(ROOT, "server");
const BLOCKCHAIN = path.join(ROOT, "blockchain");
const CLIENT = path.join(ROOT, "client");
export const PYTHON = process.env.TEST_PYTHON ?? "python3";

// why the stack can't start here, or false when it can
export function missingRequirements(): string | false {
	if (!process.env.MONGODB_URI) return "set MONGODB_URI";
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

export type RealProvider = { token: string; address: Address; child: ChildProcess };
export type LocalStack = {
	stack: Stack;
	providers: RealProvider[];
	server: ChildProcess;
	logs: string;
	logTails(lines?: number): string;
	stop(): Promise<void>;
};

export async function startLocalStack({ providers = 3, price = 0.001 } = {}): Promise<LocalStack> {
	const env = devEnv(ROOT);
	const logs = mkdtempSync(path.join(tmpdir(), "offbalance-system-"));
	const processes: { name: string; child: ChildProcess }[] = [];
	let database = "";

	const launch = (name: string, command: string, args: string[], options: { cwd: string; env?: Record<string, string> }) => {
		const log = createWriteStream(path.join(logs, `${name}.log`));
		const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout!.pipe(log);
		child.stderr!.pipe(log);
		processes.push({ name, child });
		return child;
	};
	const logTails = (lines = 25) => processes.map(({ name }) => {
		const text = existsSync(path.join(logs, `${name}.log`)) ? readFileSync(path.join(logs, `${name}.log`), "utf8") : "";
		return `----- ${name} (last ${lines} lines) -----\n${text.split("\n").slice(-lines).join("\n")}`;
	}).join("\n");
	const stop = async () => {
		for (const { child } of [...processes].reverse()) {
			try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
		}
		if (database) {
			const { default: mongoose } = await import("mongoose");
			const connection = await mongoose.createConnection(process.env.MONGODB_URI!, { dbName: database }).asPromise();
			await connection.dropDatabase().catch(() => {});
			await connection.close();
		}
	};

	try {
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
		const mongodbUri = new URL(process.env.MONGODB_URI!);
		mongodbUri.pathname = `/${database}`;
		execFileSync(process.execPath, ["seed.ts"], { cwd: SERVER, env: { ...process.env, MONGODB_URI: mongodbUri.toString() }, stdio: "ignore" });
		const apiPort = await freePort();
		const server = launch("server", process.execPath, ["server.ts"], { cwd: SERVER, env: {
			MONGODB_URI: mongodbUri.toString(), CHAIN: "on", RPC_URL: rpcUrl, DEPLOYMENT_FILE: deploymentFile,
			SERVER_PRIVATE_KEY: env.SERVER_PRIVATE_KEY, PORT: String(apiPort), HOST: "127.0.0.1",
			CHAIN_POLL_MS: "250", CHAIN_CONFIRMATIONS: "0",
			TLS_KEY_FILE: path.join(SERVER, ".local", "tls", "key.pem"), TLS_CERT_FILE: caFile,
		} });
		const apiUrl = `https://localhost:${apiPort}`;
		const stack = await until("the server", () => Stack.connect({ apiUrl, rpcUrl, caFile, env }), 60_000);

		// real provider clients, each with its own home (its job folders) on the same Docker
		const real: RealProvider[] = [];
		for (let n = 1; n <= providers; n++) {
			const child = launch(`client-${n}`, PYTHON, ["-u", "main.py", "--dev", "--provider", String(n)], { cwd: CLIENT, env: {
				OFFBALANCE_SERVER_URL: apiUrl, RPC_URL: rpcUrl, REQUESTS_CA_BUNDLE: caFile,
				HOME: mkdtempSync(path.join(tmpdir(), `offbalance-provider-${n}-`)), OFFBALANCE_SKIP_GPU_BENCHMARK: "1",
			} });
			real.push({ token: n === 1 ? "dev" : `dev${n}`, address: env[`PROVIDER_${n}_ADDRESS`] as Address, child });
		}
		// benchmarks run first, so give them time; then price them (matching needs a price)
		for (const provider of real) {
			await stack.waitForOnline(provider.token, 240_000);
			await stack.setPrice(provider.token, price);
		}
		return { stack, providers: real, server, logs, logTails, stop };
	} catch (error) {
		console.error(logTails());
		await stop();
		throw error;
	}
}
