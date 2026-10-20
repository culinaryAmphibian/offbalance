// Reads confirmed contract events through the shared monitor and submits server-only transactions.
import { readFileSync } from "node:fs";
import { Interface, JsonRpcProvider, getAddress, type InterfaceAbi } from "ethers";
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
import { BlockchainMonitor, type MonitorEvent } from "../blockchain-manager/index.ts";
import { MongoCheckpointStore, checkpointNamespace } from "../adapters/checkpoints.ts";

type ContractDeployment = { address: Address; abi: Abi; chainId: number };
type Deployment = ContractDeployment & { eventMock: { address: Address; abi: Abi } };

// Writes read this again, but refuse deployment changes until the server reconnects.
export function readDeployment(): ContractDeployment {
	const d = JSON.parse(readFileSync(config.deploymentFile, "utf8")) as Deployment;
	const contract = config.contract === "mock" ? d.eventMock : d;
	if (!Number.isSafeInteger(d.chainId) || d.chainId < 1 || !contract || !Array.isArray(contract.abi)) {
		throw new TypeError("Deployment must supply a positive chain ID, contract address, and ABI.");
	}
	return { address: getAddress(contract.address) as Address, abi: contract.abi, chainId: d.chainId };
}

export function errorMessage(error: unknown): string {
	if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") {
		return error.shortMessage;
	}
	return error instanceof Error ? error.message : String(error);
}

export type ChainEvent = { id?: string; name: string; args: Record<string, unknown>; blockNumber: bigint };

/** Preserve ABI parameter names and bigint values when crossing into the database event handler. */
export function chainEvent(event: MonitorEvent, abi: Interface): ChainEvent {
	const fragment = abi.getEvent(event.signature);
	if (!fragment) throw new Error(`Event ABI missing for ${event.signature}.`);
	const args: Record<string, unknown> = {};
	for (const [index, input] of fragment.inputs.entries()) {
		args[input.name || String(index)] = event.args[index] as unknown;
	}
	return { id: event.id, name: event.name, args, blockNumber: BigInt(event.blockNumber) };
}

export class Chain {
	private readonly publicClient: PublicClient;
	private readonly walletClient: WalletClient | null;
	private readonly provider: JsonRpcProvider;
	private readonly deployment: ContractDeployment;
	private readonly monitor: BlockchainMonitor;
	private handle: ((event: ChainEvent) => Promise<void>) | null = null;
	private stopped = false;

	private constructor(publicClient: PublicClient, walletClient: WalletClient | null,
		provider: JsonRpcProvider, deployment: ContractDeployment) {
		this.publicClient = publicClient;
		this.walletClient = walletClient;
		this.provider = provider;
		this.deployment = deployment;
		const abi = new Interface(deployment.abi as InterfaceAbi);
		this.monitor = new BlockchainMonitor({
			provider, address: deployment.address, abi: deployment.abi as InterfaceAbi, chainId: deployment.chainId,
			checkpointStore: new MongoCheckpointStore(checkpointNamespace(deployment.chainId, deployment.address)),
			startBlock: config.chainStartBlock,
			confirmations: config.chainConfirmations ?? ([1337, 31337].includes(deployment.chainId) ? 0 : 6),
			pollIntervalMs: config.chainPollMs,
			onEvent: async event => {
				if (!this.handle) throw new Error("A chain event handler is required before polling.");
				await this.handle(chainEvent(event, abi));
			},
			onError: error => { console.error("Chain poll failed:", errorMessage(error)); },
		});
	}

	// null when disabled or unreachable; database-only operation remains available.
	static async connect(): Promise<Chain | null> {
		if (!config.chainEnabled) return null;
		let provider: JsonRpcProvider | undefined;
		try {
			const deployment = readDeployment();
			const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
			const actual = await publicClient.getChainId();
			if (actual !== deployment.chainId) {
				throw new Error(`node is chain ${actual}, deployment is for ${deployment.chainId}`);
			}
			const code = await publicClient.getCode({ address: deployment.address });
			if (!code || code === "0x") throw new Error(`no contract at ${deployment.address}`);
			const walletClient = config.serverPrivateKey ? createWalletClient({
				account: privateKeyToAccount(config.serverPrivateKey), transport: http(config.rpcUrl),
			}) : null;
			if (!walletClient && config.contract === "real") {
				console.warn("SERVER_PRIVATE_KEY not set: chain events are enabled; server transactions will fail.");
			}
			provider = new JsonRpcProvider(config.rpcUrl, deployment.chainId, { staticNetwork: true });
			const chain = new Chain(publicClient, walletClient, provider, deployment);
			console.log(`Chain: ${config.contract} contract ${deployment.address} via ${config.rpcUrl}`);
			return chain;
		} catch (error) {
			provider?.destroy();
			console.warn(`Chain unavailable (${errorMessage(error)}); running database-only. Set CHAIN=off to silence this.`);
			return null;
		}
	}

	get canWrite(): boolean {
		return !this.stopped && this.walletClient !== null && config.contract === "real";
	}

	private async write(functionName: string, args: unknown[]): Promise<void> {
		if (config.contract === "mock") return;
		if (this.stopped) throw new Error("Chain connection has stopped.");
		const wallet = this.walletClient;
		if (!wallet?.account) throw new Error("SERVER_PRIVATE_KEY is required for server contract transactions.");
		const { address, abi, chainId } = readDeployment();
		if (chainId !== this.deployment.chainId || address.toLowerCase() !== this.deployment.address.toLowerCase()) {
			throw new Error("Contract deployment changed; restart the chain connection before submitting transactions.");
		}
		const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: null });
		const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
		if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
	}

	assignProviders(jobId: number, providers: string[]): Promise<void> {
		return this.write("assignProviders", [BigInt(jobId), providers]);
	}

	verifyReceipt(jobId: number, provider: string): Promise<void> {
		return this.write("verifyReceipt", [BigInt(jobId), provider]);
	}

	async listen(handle: (event: ChainEvent) => Promise<void>): Promise<void> {
		if (this.stopped) throw new Error("Chain connection has stopped.");
		if (this.handle) throw new Error("Chain listener is already registered.");
		this.handle = handle;
		this.monitor.start();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		try { await this.monitor.stop(); }
		finally { this.provider.destroy(); }
	}
}
