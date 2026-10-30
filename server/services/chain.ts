// Reads confirmed contract events through the shared monitor and submits server-only transactions.
import { readFileSync } from "node:fs";
import { Interface, JsonRpcProvider, getAddress, type InterfaceAbi } from "ethers";
import {
	createPublicClient,
	createWalletClient,
	http,
	encodeFunctionData,
	keccak256,
	parseTransaction,
	type Abi,
	type Address,
	type PublicClient,
	type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.ts";
import { BlockchainMonitor, ReorgError, type MonitorEvent } from "../blockchain-manager/index.ts";
import { MongoCheckpointStore, checkpointNamespace } from "../adapters/checkpoints.ts";
import { MongoTransactionStore } from "../adapters/transactions.ts";
import { DurableTransactions, TransactionPendingError } from "./transactions.ts";

type ContractDeployment = { address: Address; abi: Abi; chainId: number };

// Writes read this again, but refuse deployment changes until the server reconnects.
export function readDeployment(): ContractDeployment {
	const d = JSON.parse(readFileSync(config.deploymentFile, "utf8")) as ContractDeployment;
	if (!Number.isSafeInteger(d.chainId) || d.chainId < 1 || !d.address || !Array.isArray(d.abi)) {
		throw new TypeError("Deployment must supply a positive chain ID, contract address, and ABI.");
	}
	return { address: getAddress(d.address) as Address, abi: d.abi, chainId: d.chainId };
}

export function errorMessage(error: unknown): string {
	if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") {
		return error.shortMessage;
	}
	return error instanceof Error ? error.message : String(error);
}

// Chain-time deadlines (unix seconds) from OffBalance.getDeadlines; 0 until that phase starts.
export type Deadlines = { status: number; commitDeadline: bigint; revealDeadline: bigint; deliveryDeadline: bigint };

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

/** Nonce replacement receipts do not establish that the journaled operation executed. */
export function assertReceiptHash(expected: string, actual: string): void {
	if (expected.toLowerCase() !== actual.toLowerCase()) {
		throw new TransactionPendingError('Journaled transaction was replaced; explicit nonce reconciliation is required.');
	}
}

export class ChainConfigurationError extends Error {}

export function validateChainTiming(options: {
	chainId: number; confirmations: number; pollMs: number; revealWindow: bigint; deliveryWindow: bigint;
	blockTimeS?: number; transactionBudgetS?: number;
}): void {
	const { chainId, confirmations, pollMs, revealWindow, deliveryWindow, blockTimeS, transactionBudgetS } = options;
	if (!Number.isSafeInteger(confirmations) || confirmations < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
		throw new ChainConfigurationError("Invalid chain confirmation or polling settings.");
	}
	if ([1337, 31337].includes(chainId)) return;
	if (!Number.isFinite(blockTimeS) || blockTimeS! <= 0 || !Number.isFinite(transactionBudgetS) || transactionBudgetS! <= 0) {
		throw new ChainConfigurationError("Nonlocal chains require CHAIN_BLOCK_TIME_S and CHAIN_TRANSACTION_BUDGET_S for deadline compatibility validation.");
	}
	const required = confirmations * blockTimeS! + pollMs / 1000 + transactionBudgetS!;
	if (required >= Number(revealWindow) || required >= Number(deliveryWindow)) {
		throw new ChainConfigurationError(`Confirmation and transaction budget ${required}s must fit inside reveal ${revealWindow}s and delivery ${deliveryWindow}s windows.`);
	}
}

export class Chain {
	private readonly publicClient: PublicClient;
	private readonly walletClient: WalletClient | null;
	private readonly provider: JsonRpcProvider;
	private readonly deployment: ContractDeployment;
	private readonly genesisHash: string;
	private readonly monitor: BlockchainMonitor;
	private readonly transactions: DurableTransactions | null;
	private handle: ((event: ChainEvent) => Promise<void>) | null = null;
	private stopped = false;
	private writeHalted = false;

	private constructor(publicClient: PublicClient, walletClient: WalletClient | null,
		provider: JsonRpcProvider, deployment: ContractDeployment, genesisHash: string) {
		this.publicClient = publicClient;
		this.walletClient = walletClient;
		this.provider = provider;
		this.deployment = deployment;
		this.genesisHash = genesisHash;
		this.transactions = walletClient?.account ? new DurableTransactions(
			new MongoTransactionStore(`${deployment.chainId}:${walletClient.account.address.toLowerCase()}`), {
				prepare: async intent => {
					await this.assertCanonicalCheckpoint();
					const { functionName, args } = JSON.parse(intent, (_key, value) =>
						typeof value === 'string' && /^bigint:\d+$/.test(value) ? BigInt(value.slice(7)) : value);
					const wallet = walletClient;
					await publicClient.simulateContract({ address: deployment.address, abi: deployment.abi, functionName, args, account: wallet.account! });
					const nonce = await publicClient.getTransactionCount({ address: wallet.account!.address, blockTag: 'pending' });
					const request = await wallet.prepareTransactionRequest({ account: wallet.account!, chain: null,
						chainId: deployment.chainId, type: 'eip1559', to: deployment.address,
						data: encodeFunctionData({ abi: deployment.abi, functionName, args }), nonce });
					const { account: _account, chain: _chain, ...transaction } = request;
					await this.assertCanonicalCheckpoint();
					const raw = await privateKeyToAccount(config.serverPrivateKey!).signTransaction({ ...transaction, chainId: deployment.chainId });
					return { hash: keccak256(raw), raw, nonce, intent, state: 'pending' };
				},
				receipt: async hash => {
					try {
						const receipt = await publicClient.getTransactionReceipt({ hash });
						assertReceiptHash(hash, receipt.transactionHash);
						const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
						if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
							this.writeHalted = true;
							throw new TransactionPendingError('Transaction receipt belongs to a noncanonical block; writes halted.');
						}
						const confirmations = config.chainConfirmations ?? ([1337, 31337].includes(deployment.chainId) ? 0 : 6);
						if (await publicClient.getBlockNumber() < receipt.blockNumber + BigInt(confirmations)) return null;
						return receipt.status;
					} catch (error) {
						if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return null;
						throw error;
					}
				},
				broadcast: async serializedTransaction => {
					await this.assertCanonicalCheckpoint();
					const tx = parseTransaction(serializedTransaction);
					if (tx.to?.toLowerCase() !== deployment.address.toLowerCase() || Number(tx.chainId) !== deployment.chainId) {
						throw new TransactionPendingError('Pending signed transaction targets another deployment; reconcile it explicitly.');
					}
					await publicClient.sendRawTransaction({ serializedTransaction });
				},
				wait: async hash => {
					const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000,
						confirmations: 1 + (config.chainConfirmations ?? ([1337, 31337].includes(deployment.chainId) ? 0 : 6)) });
					assertReceiptHash(hash, receipt.transactionHash);
					const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
					if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
						this.writeHalted = true;
						throw new TransactionPendingError('Mined receipt is no longer canonical; writes halted.');
					}
					return receipt.status;
				},
			}) : null;
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
			onError: error => {
				if (error instanceof ReorgError) this.writeHalted = true;
				console.error("Chain poll failed:", errorMessage(error));
			},
		});
	}

	// Database-only operation is explicit; an enabled chain must never silently downgrade.
	static async connect(): Promise<Chain | null> {
		if (!config.chainEnabled) return null;
		let provider: JsonRpcProvider | undefined;
		try {
			const deployment = readDeployment();
			const publicClient = createPublicClient({ transport: http(config.rpcUrl, { timeout: 10_000 }) });
			const actual = await publicClient.getChainId();
			if (actual !== deployment.chainId) {
				throw new Error(`node is chain ${actual}, deployment is for ${deployment.chainId}`);
			}
			const code = await publicClient.getCode({ address: deployment.address });
			if (!code || code === "0x") throw new Error(`no contract at ${deployment.address}`);
			const genesisHash = (await publicClient.getBlock({ blockNumber: 0n })).hash;
			if (!genesisHash) throw new ChainConfigurationError("Cannot identify the chain genesis block.");
			const walletClient = config.serverPrivateKey ? createWalletClient({
				// the orchestrator, matcher and receipt checks send concurrently from this one key
				account: privateKeyToAccount(config.serverPrivateKey), transport: http(config.rpcUrl, { timeout: 10_000 }),
			}) : null;
			if (!walletClient?.account) throw new ChainConfigurationError("SERVER_PRIVATE_KEY is required when the chain is enabled.");
			const contractServer = await publicClient.readContract({ address: deployment.address, abi: deployment.abi, functionName: 'server' }) as Address;
			if (contractServer.toLowerCase() !== walletClient.account.address.toLowerCase()) {
				throw new ChainConfigurationError('SERVER_PRIVATE_KEY does not match the deployed contract server authority.');
			}
			const [revealWindow, deliveryWindow] = await Promise.all(['REVEAL_WINDOW', 'DELIVERY_WINDOW'].map(functionName =>
				publicClient.readContract({ address: deployment.address, abi: deployment.abi, functionName }) as Promise<bigint>));
			validateChainTiming({ chainId: deployment.chainId,
				confirmations: config.chainConfirmations ?? ([1337, 31337].includes(deployment.chainId) ? 0 : 6),
				pollMs: config.chainPollMs, revealWindow, deliveryWindow,
				blockTimeS: config.chainBlockTimeS,
				transactionBudgetS: config.chainTransactionBudgetS });
			provider = new JsonRpcProvider(config.rpcUrl, deployment.chainId, { staticNetwork: true });
			const chain = new Chain(publicClient, walletClient, provider, deployment, genesisHash);
			console.log(`Chain: OffBalance ${deployment.address} via ${config.rpcUrl}`);
			return chain;
		} catch (error) {
			provider?.destroy();
			if (error instanceof ChainConfigurationError) throw error;
			throw new Error(`Chain unavailable (${errorMessage(error)}); refusing database-only fallback while chain is enabled.`, { cause: error });
		}
	}

	get deploymentIdentity(): { chainId: number; address: string; genesisHash: string } {
		return { chainId: this.deployment.chainId, address: this.deployment.address, genesisHash: this.genesisHash };
	}

	get canWrite(): boolean {
		return !this.stopped && !this.writeHalted && this.walletClient !== null;
	}

	private async write(functionName: string, args: unknown[]): Promise<void> {
		await this.assertCanonicalCheckpoint();
		if (this.stopped) throw new Error("Chain connection has stopped.");
		const wallet = this.walletClient;
		if (!wallet?.account) throw new Error("SERVER_PRIVATE_KEY is required for server contract transactions.");
		const { address, chainId } = readDeployment();
		if (chainId !== this.deployment.chainId || address.toLowerCase() !== this.deployment.address.toLowerCase()) {
			throw new Error("Contract deployment changed; restart the chain connection before submitting transactions.");
		}
		const intent = JSON.stringify({ address: address.toLowerCase(), functionName, args },
			(_key, value) => typeof value === 'bigint' ? `bigint:${value}` : value);
		await this.transactions!.execute(intent);
	}

	assignProviders(jobId: number, providers: string[]): Promise<void> {
		return this.write("assignProviders", [BigInt(jobId), providers]);
	}

	verifyReceipt(jobId: number, provider: string): Promise<void> {
		return this.write("verifyReceipt", [BigInt(jobId), provider]);
	}

	// Deadline-gated phase transitions. They're public on-chain; the server is just the default caller.
	startRevealPhase(jobId: number): Promise<void> {
		return this.write("startRevealPhase", [BigInt(jobId)]);
	}

	endRevealPhase(jobId: number): Promise<void> {
		return this.write("endRevealPhase", [BigInt(jobId)]);
	}

	endDeliveryPhase(jobId: number): Promise<void> {
		return this.write("endDeliveryPhase", [BigInt(jobId)]);
	}

	async getDeadlines(jobId: number): Promise<Deadlines> {
		const [status, commitDeadline, revealDeadline, deliveryDeadline] = await this.publicClient.readContract({
			address: this.deployment.address, abi: this.deployment.abi, functionName: "getDeadlines", args: [BigInt(jobId)],
		}) as readonly [number, bigint, bigint, bigint];
		return { status: Number(status), commitDeadline, revealDeadline, deliveryDeadline };
	}

	private async assertCanonicalCheckpoint(): Promise<void> {
		if (this.stopped) throw new TransactionPendingError('Chain connection has stopped.');
		if (this.writeHalted) throw new TransactionPendingError('Chain reorganization requires reconciliation before signing.');
		try {
			const genesis = await this.publicClient.getBlock({ blockNumber: 0n });
			if (genesis.hash?.toLowerCase() !== this.genesisHash.toLowerCase()) {
				this.writeHalted = true;
				throw new TransactionPendingError('Chain genesis changed; refusing recovery transactions against a reset chain.');
			}
			const checkpoint = await new MongoCheckpointStore(checkpointNamespace(this.deployment.chainId, this.deployment.address)).load();
			if (checkpoint && checkpoint.blockNumber >= 0) {
				const block = await this.publicClient.getBlock({ blockNumber: BigInt(checkpoint.blockNumber) });
				if (block.hash?.toLowerCase() !== checkpoint.blockHash?.toLowerCase()) {
					this.writeHalted = true;
					throw new TransactionPendingError('Chain checkpoint changed; transaction writes are halted for reconciliation.');
				}
			}
		} catch (error) {
			if (error instanceof TransactionPendingError) throw error;
			throw new TransactionPendingError('Cannot verify canonical chain checkpoint; refusing transaction writes.', { cause: error });
		}
	}

	async recoverTransactions(): Promise<void> {
		await this.assertCanonicalCheckpoint();
		await this.transactions?.recover();
	}

	async getAssignedProviders(jobId: number): Promise<string[]> {
		return await this.publicClient.readContract({ address: this.deployment.address, abi: this.deployment.abi,
			functionName: 'getAssignedProviders', args: [BigInt(jobId)] }) as string[];
	}

	// The latest block's timestamp: the clock the contract checks deadlines against.
	async chainTime(): Promise<bigint> {
		return (await this.publicClient.getBlock()).timestamp;
	}

	async listen(handle: (event: ChainEvent) => Promise<void>): Promise<void> {
		if (this.stopped) throw new Error("Chain connection has stopped.");
		if (this.handle) throw new Error("Chain listener is already registered.");
		this.handle = handle;
		this.monitor.start();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		try { await this.monitor.stop(); await this.transactions?.idle(); }
		finally { this.provider.destroy(); }
	}
}
