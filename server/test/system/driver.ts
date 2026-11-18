// Drives a running OffBalance stack the way its users do, for the system tests:
//   - the buyer: POST /jobs, then submitJob from the buyer's wallet (as frontend/src/chain.js
//     does), cancelJob, polling the job, downloading the result
//   - a scripted provider (dev provider 4) that registers like a real client and then misbehaves
//     on purpose: it cheats (commits a different answer) or never shows up (never stakes)
// It only uses public interfaces: the HTTPS API (trusting the stack's own certificate) and the
// chain's JSON-RPC. Used by system-full-stack.test.ts (starts everything itself) and
// compose-smoke.ts (attaches to `docker compose --profile host`).
import { readFileSync } from "node:fs";
import { request } from "node:https";
import path from "node:path";
import { extract } from "tar-stream";
import {
	createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, nonceManager,
	parseEther, toHex, type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { testProfile } from "../helpers/hardware.ts";

// OffBalance.Status
export const Status = { JOB_SUBMITTED: 0, PROVIDER_SELECTED: 1, COMMIT: 3, REVEAL: 4, DELIVERING: 6, PAID: 8, CANCELED: 9, NO_QUORUM: 10 } as const;
const FINAL = new Set<number>([Status.PAID, Status.CANCELED, Status.NO_QUORUM]);

export function devEnv(root = path.join(import.meta.dirname, "..", "..", "..")): Record<string, string> {
	return Object.fromEntries(readFileSync(path.join(root, "dev.env"), "utf8").split("\n")
		.map(line => line.trim()).filter(line => line && !line.startsWith("#") && line.includes("="))
		.map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function until<T>(what: string, check: () => Promise<T | undefined | false | null>, timeoutMs: number): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		// transient errors (a busy RPC, a restarting server) are retried; `final` ones aren't
		const value = await check().catch(error => { if (error?.final) throw error; return undefined; });
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
		await sleep(500);
	}
}

export type StackConfig = { apiUrl: string; rpcUrl: string; caFile: string; env?: Record<string, string> };
type ApiResponse = { status: number; body: any; bytes: Buffer };

export class Stack {
	readonly config: StackConfig;
	readonly env: Record<string, string>;
	readonly rpc: PublicClient;
	readonly buyer: WalletClient;
	address!: Address;
	abi!: Abi;
	private readonly ca: Buffer;

	constructor(config: StackConfig) {
		this.config = config;
		this.env = config.env ?? devEnv();
		this.ca = readFileSync(config.caFile);
		this.rpc = createPublicClient({ transport: http(config.rpcUrl) });
		this.buyer = this.wallet(this.env.BUYER_PRIVATE_KEY);
	}

	static async connect(config: StackConfig): Promise<Stack> {
		const stack = new Stack(config);
		const contract = await stack.api("GET", "/contract_address");
		if (contract.status !== 200) throw new Error(`GET /contract_address: ${contract.status} ${JSON.stringify(contract.body)}`);
		stack.address = contract.body.address;
		stack.abi = contract.body.abi;
		return stack;
	}

	wallet(key: string): WalletClient {
		return createWalletClient({ account: privateKeyToAccount(key as Hex, { nonceManager }), transport: http(this.config.rpcUrl), chain: null });
	}

	// HTTPS against the stack's own certificate (verification stays on)
	api(method: string, route: string, { token = "dev-buyer", body }: { token?: string | null; body?: unknown } = {}): Promise<ApiResponse> {
		const url = new URL(route, this.config.apiUrl);
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		return new Promise((resolve, reject) => {
			const req = request(url, {
				method, ca: this.ca, timeout: 30_000,
				headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { "Content-Type": "application/json" } : {}) },
			}, res => {
				const chunks: Buffer[] = [];
				res.on("data", chunk => chunks.push(chunk));
				res.on("end", () => {
					const bytes = Buffer.concat(chunks);
					let parsed: unknown = null;
					if ((res.headers["content-type"] ?? "").includes("json")) try { parsed = JSON.parse(bytes.toString()); } catch { /* not JSON */ }
					resolve({ status: res.statusCode ?? 0, body: parsed, bytes });
				});
			});
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error(`${method} ${route} timed out`)));
			req.end(payload);
		});
	}

	read<T>(functionName: string, args: unknown[] = []): Promise<T> {
		return this.rpc.readContract({ address: this.address, abi: this.abi, functionName, args }) as Promise<T>;
	}

	async send(who: WalletClient, functionName: string, args: unknown[], value = 0n): Promise<void> {
		const hash = await who.writeContract({ address: this.address, abi: this.abi, functionName, args, value, account: who.account!, chain: null });
		const receipt = await this.rpc.waitForTransactionReceipt({ hash });
		if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
	}

	status(jobId: number): Promise<number> {
		return this.read<number>("getJobStatus", [BigInt(jobId)]);
	}

	credits(address: Address): Promise<bigint> {
		return this.read<bigint>("credits", [address]);
	}

	requiredStake(jobId: number, provider: Address): Promise<bigint> {
		return this.read<readonly unknown[]>("getProviderCommitment", [BigInt(jobId), provider]).then(c => c[4] as bigint);
	}

	// ───────────── the buyer ─────────────

	// Saves the job, then submits it from the buyer's wallet with the same arguments as the
	// frontend: the escrow is maxPrice, and the contract's k/quorum are the API's
	// minNodesToAgree/minNodesToRun.
	async submitJob(job: { name: string; command: string[]; providers: number; agree: number; window: number; maxPrice: string; image?: string }): Promise<number> {
		const saved = await this.api("POST", "/jobs", { body: {
			name: job.name, image: job.image ?? "alpine:3.20", command: job.command, maxPrice: job.maxPrice,
			minNodesToRunOn: job.providers, minNodesToAgree: job.agree, timeWindow: job.window,
		} });
		if (saved.status !== 201) throw new Error(`POST /jobs: ${saved.status} ${JSON.stringify(saved.body)}`);
		const id = Number(saved.body.job.id);
		const price = parseEther(job.maxPrice);
		const hash = await this.buyer.writeContract({ address: this.address, abi: this.abi, functionName: "submitJob",
			args: [price, BigInt(job.agree), BigInt(job.providers), BigInt(job.window), saved.body.job.dockerImageDigest],
			value: price, account: this.buyer.account!, chain: null });
		const receipt = await this.rpc.waitForTransactionReceipt({ hash });
		const [submitted] = await this.rpc.getContractEvents({ address: this.address, abi: this.abi, eventName: "JOB_SUBMITTED",
			fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber }) as unknown as { args: { jobId: bigint } }[];
		// TESTING_PLAN.md B1: the database and the contract number jobs separately
		if (Number(submitted.args.jobId) !== id) throw new Error(`the server saved job ${id} but the contract calls it ${submitted.args.jobId} (B1)`);
		return id;
	}

	cancelOnChain(jobId: number): Promise<void> {
		return this.send(this.buyer, "cancelJob", [BigInt(jobId)]);
	}

	async waitForStatus(jobId: number, wanted: number[], timeoutMs: number): Promise<number> {
		return until(`job ${jobId} to reach status ${wanted.join("/")}`, async () => {
			const s = await this.status(jobId);
			if (FINAL.has(s) && !wanted.includes(s)) throw Object.assign(new Error(`job ${jobId} ended in status ${s}`), { final: true });
			return wanted.includes(s) ? s : undefined;
		}, timeoutMs).catch(async error => {
			const s = await this.status(jobId);
			throw new Error(`${error.message} (now ${s})`);
		});
	}

	async job(jobId: number): Promise<any> {
		const res = await this.api("GET", `/jobs/${jobId}`);
		if (res.status !== 200) throw new Error(`GET /jobs/${jobId}: ${res.status}`);
		return res.body.job;
	}

	// the buyer's result download, unpacked: file name -> contents
	async download(jobId: number): Promise<Map<string, string>> {
		const res = await this.api("GET", `/jobs/${jobId}/result`);
		if (res.status !== 200) throw new Error(`GET /jobs/${jobId}/result: ${res.status} ${res.bytes.toString().slice(0, 200)}`);
		const files = new Map<string, string>();
		await new Promise<void>((resolve, reject) => {
			const tar = extract();
			tar.on("entry", (header, stream, next) => {
				const chunks: Buffer[] = [];
				stream.on("data", (c: Buffer) => chunks.push(c));
				stream.on("end", () => { if (header.type === "file") files.set(header.name, Buffer.concat(chunks).toString()); next(); });
				stream.resume();
			});
			tar.on("finish", resolve);
			tar.on("error", reject);
			tar.end(res.bytes);
		});
		return files;
	}

	// ───────────── providers ─────────────

	async setPrice(token: string, price: number): Promise<void> {
		const res = await this.api("POST", "/provider/price", { token, body: { price } });
		if (res.status !== 200) throw new Error(`price for ${token}: ${res.status} ${JSON.stringify(res.body)}`);
	}

	// a real client has benchmarked and is sending heartbeats
	waitForOnline(token: string, timeoutMs: number): Promise<boolean> {
		return until(`provider ${token} online`, async () => {
			const res = await this.api("GET", "/provider/hardware", { token });
			return res.status === 200 && res.body.hardware && res.body.online;
		}, timeoutMs);
	}
}

export type Behaviour = "cheat" | "no-show" | "offline";

// Dev provider 4, played by the test: registers and heartbeats like the real client, then
// misbehaves on every job it's assigned.
export class ScriptedProvider {
	private readonly stack: Stack;
	private readonly token: string;
	readonly wallet: WalletClient;
	readonly address: Address;
	behaviour: Behaviour = "offline";
	readonly handled: { jobId: number; behaviour: Behaviour }[] = [];
	private timer?: NodeJS.Timeout;
	private fromBlock = 0n;
	private busy = Promise.resolve();

	constructor(stack: Stack, token = "dev4", key = stack.env.PROVIDER_4_PRIVATE_KEY) {
		this.stack = stack;
		this.token = token;
		this.wallet = stack.wallet(key);
		this.address = this.wallet.account!.address;
	}

	async start(behaviour: Behaviour, price: number): Promise<void> {
		this.behaviour = behaviour;
		const scores = await this.stack.api("POST", "/scores", { token: this.token, body: testProfile() });
		if (scores.status !== 201) throw new Error(`scripted provider /scores: ${scores.status}`);
		await this.stack.setPrice(this.token, price);
		this.fromBlock = await this.stack.rpc.getBlockNumber();
		const tick = async () => {
			if (this.behaviour !== "offline") await this.stack.api("POST", "/provider/heartbeat", { token: this.token }).catch(() => {});
			await this.watch().catch(error => console.error("scripted provider:", error));
			this.timer = setTimeout(tick, 1_000);
		};
		await tick();
	}

	stop(): void {
		clearTimeout(this.timer);
		this.behaviour = "offline";
	}

	private async watch(): Promise<void> {
		const head = await this.stack.rpc.getBlockNumber();
		if (head < this.fromBlock) return;
		const events = await this.stack.rpc.getContractEvents({ address: this.stack.address, abi: this.stack.abi,
			eventName: "PROVIDER_SELECTED", fromBlock: this.fromBlock, toBlock: head }) as unknown as { args: { jobId: bigint; provider: Address; stake: bigint } }[];
		this.fromBlock = head + 1n;
		for (const e of events) {
			if (e.args.provider.toLowerCase() !== this.address.toLowerCase()) continue;
			const behaviour = this.behaviour;
			this.handled.push({ jobId: Number(e.args.jobId), behaviour });
			if (behaviour === "cheat") this.busy = this.busy.then(() => this.cheat(Number(e.args.jobId), e.args.stake)).catch(error => console.error("cheat failed:", error));
		}
	}

	// stakes, then commits and reveals an answer nobody else will have
	private async cheat(jobId: number, stake: bigint): Promise<void> {
		await this.stack.send(this.wallet, "submitStake", [BigInt(jobId)], stake);
		const output = keccak256(toHex(`made up ${jobId} ${Math.random()}`));
		const salt = keccak256(toHex(`salt ${jobId}`));
		const commitment = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(output), salt]));
		await this.stack.waitForStatus(jobId, [Status.COMMIT], 120_000);
		await this.stack.send(this.wallet, "submitCommitment", [BigInt(jobId), commitment]);
		await this.stack.waitForStatus(jobId, [Status.REVEAL], 180_000);
		await this.stack.send(this.wallet, "submitReveal", [BigInt(jobId), output, salt]);
	}
}
