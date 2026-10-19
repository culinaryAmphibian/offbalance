// Blockchain manager: reads the deployment, sends the server-only transactions
// (assignProviders, verifyReceipt) and polls contract events in block order.
import { readFileSync } from "node:fs";
import {
	createPublicClient,
	createWalletClient,
	http,
	type Abi,
	type Address,
	type PublicClient,
	type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.ts";
import { getSeq, setSeq } from "../models/index.ts";

type Deployment = {
	chainId: number;
	address: Address;
	abi: Abi;
	eventMock: { address: Address; abi: Abi };
};

// read on every call so a redeploy is picked up without restarting
export function readDeployment(): { address: Address; abi: Abi; chainId: number } {
	const d: Deployment = JSON.parse(readFileSync(config.deploymentFile, "utf8"));
	return config.contract === "mock"
		? { ...d.eventMock, chainId: d.chainId }
		: { address: d.address, abi: d.abi, chainId: d.chainId };
}

// viem errors carry a one-line shortMessage; the full message is a page long
export function errorMessage(e: unknown): string {
	return (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
}

export type ChainEvent = { name: string; args: Record<string, unknown>; blockNumber: bigint };

const CURSOR = "chainCursor"; // last fully processed block

export class Chain {
	private stopped = false;
	private publicClient: PublicClient;
	private walletClient: WalletClient | null;

	private constructor(publicClient: PublicClient, walletClient: WalletClient | null) {
		this.publicClient = publicClient;
		this.walletClient = walletClient;
	}

	// null when the chain is turned off or unreachable; the server then runs database-only
	static async connect(): Promise<Chain | null> {
		if (!config.chainEnabled) return null;
		try {
			const { address, chainId } = readDeployment();
			const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
			const actual = await publicClient.getChainId();
			if (actual !== chainId) throw new Error(`node is chain ${actual}, deployment is for ${chainId}`);
			if (!(await publicClient.getCode({ address }))) throw new Error(`no contract at ${address}`);

			let walletClient: WalletClient | null = null;
			if (config.serverPrivateKey) {
				walletClient = createWalletClient({
					account: privateKeyToAccount(config.serverPrivateKey),
					transport: http(config.rpcUrl),
				});
			} else {
				console.warn("SERVER_PRIVATE_KEY not set: listening to the chain, but can't assign providers on-chain");
			}
			console.log(`Chain: ${config.contract} contract ${address} via ${config.rpcUrl}`);
			return new Chain(publicClient as PublicClient, walletClient);
		} catch (e) {
			console.warn(`Chain unavailable (${errorMessage(e)}); running database-only. Set CHAIN=off to silence this.`);
			return null;
		}
	}

	// the event mock has no server functions; matching then only updates the database
	get canWrite(): boolean {
		return this.walletClient !== null && config.contract === "real";
	}

	private async write(functionName: string, args: unknown[]): Promise<void> {
		if (!this.canWrite) return;
		const { address, abi } = readDeployment();
		const wallet = this.walletClient!;
		const hash = await wallet.writeContract({
			address, abi, functionName, args, account: wallet.account!, chain: null,
		});
		const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
		if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
	}

	assignProviders(jobId: number, providers: string[]): Promise<void> {
		return this.write("assignProviders", [BigInt(jobId), providers]);
	}

	verifyReceipt(jobId: number, provider: string): Promise<void> {
		return this.write("verifyReceipt", [BigInt(jobId), provider]);
	}

	// Polls for contract events and hands them to `handle` one at a time, in order.
	// The cursor lives in Mongo, so a restart resumes where it left off.
	async listen(handle: (e: ChainEvent) => Promise<void>): Promise<void> {
		while (!this.stopped) {
			try {
				await this.pollOnce(handle);
			} catch (e) {
				console.error("Chain poll failed:", errorMessage(e));
			}
			await new Promise((r) => setTimeout(r, config.chainPollMs));
		}
	}

	private async pollOnce(handle: (e: ChainEvent) => Promise<void>): Promise<void> {
		const latest = await this.publicClient.getBlockNumber();
		let cursor = BigInt((await getSeq(CURSOR)) ?? -1);
		// a fresh `hardhat node` starts over at block 0
		if (cursor > latest) {
			console.warn(`Chain restarted (cursor ${cursor} > head ${latest}); rescanning from block 0`);
			cursor = -1n;
		}
		if (cursor >= latest) return;

		const { address, abi } = readDeployment();
		const logs = await this.publicClient.getContractEvents({
			address, abi, fromBlock: cursor + 1n, toBlock: latest,
		});
		for (const log of logs) {
			const event = {
				name: log.eventName as string,
				args: log.args as Record<string, unknown>,
				blockNumber: log.blockNumber!,
			};
			try {
				await handle(event);
			} catch (e) {
				console.error(`Handling ${event.name} failed:`, e);
			}
		}
		await setSeq(CURSOR, Number(latest));
	}

	stop(): void {
		this.stopped = true;
	}
}
