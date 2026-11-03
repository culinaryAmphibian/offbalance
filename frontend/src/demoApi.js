import { normalizeJob } from "./jobs.js";

const wallet = "0x71C0000000000000000000000000000000009A2F";
const stamp = new Date().toISOString();
const defaults = {
	dockerImage: "ghcr.io/example/compute:latest",
	maxPrice: "0.008",
	k: 3,
	quorum: 2,
	window: 3600,
	requirements: { minVcpus: 2, minMemoryGb: 4, gpu: "none", minGpuVramGb: 0 },
	createdAt: stamp,
	providerCount: 3,
	executionMode: "demo",
};

export function createDemoApi() {
	let provider = {
		registered: true,
		online: true,
		lastSeen: stamp,
		currentStake: "0.050",
		pricePerHour: "0.002",
		suggestedPricePerHour: "0.0004423",
		suggestedPrice: {
			formula: {
				pricePerHour: "0.0004423",
				items: [
					{ label: "CPU", detail: "16 vCPUs × 1.36× reference speed × 0.0000133 ETH", pricePerHour: "0.0002894" },
					{ label: "Memory", detail: "31.2 GB × 0.00000167 ETH", pricePerHour: "0.0000521" },
					{ label: "GPU 0", detail: "NVIDIA GeForce RTX 3060: 12.1 TFLOPS × 0.00000833 ETH", pricePerHour: "0.0001008" },
				],
			},
			market: { pricePerHour: "0.002", similarMachines: 3 },
		},
		machine: {
			cpu: { model: "AMD Ryzen 7 7700X 8-Core Processor", cores: 8, threads: 16, singleThreadMBps: 61.2, multiThreadMBps: 612.4 },
			memory: { totalGb: 31.2, bandwidthGBps: 18.5 },
			gpus: [{ vendor: "nvidia", index: 0, model: "NVIDIA GeForce RTX 3060", vramGb: 12, driver: "550.54.14",
				runtime: "CUDA 12.4", fp32Tflops: 12.1, memoryBandwidthGBps: 338, error: null }],
			relative: {
				cpuSingleThread: 1.36, cpuMultiThread: 3.73, memoryBandwidth: 1.89, gpuFp32: 1.83, gpuMemoryBandwidth: 0.95, gpus: [1.83],
				reference: "Intel Core i7-9700K (4 cores), 16 GB dual-channel DDR4, NVIDIA GeForce RTX 2070",
			},
			updatedAt: stamp,
		},
	};
	let jobs = [
		{
			...defaults,
			id: "demo-024",
			name: "Image processing",
			status: "COMMIT_PHASE",
			startedAt: stamp,
			runtimeSeconds: 124,
			consensus: { agreeing: 0, required: 2 },
		},
		{
			...defaults,
			id: "demo-023",
			name: "Simulation batch",
			status: "DELIVERY_RECEIPT_VALIDATION",
			runtimeSeconds: 92,
			consensus: { agreeing: 3, required: 2 },
			delivery: { status: "RECEIVED", receivedAt: stamp },
			payment: { status: "PENDING" },
		},
		{
			...defaults,
			id: "demo-021",
			name: "Matrix computation",
			status: "COMPLETED",
			spent: "0.004",
			earnings: "0.003",
			runtimeSeconds: 68,
			consensus: { agreeing: 3, required: 2 },
			consensusResultHash: "demo-result-hash",
			delivery: {
				status: "VERIFIED",
				receivedAt: stamp,
				verifiedAt: stamp,
			},
			payment: { status: "PAID", settledAt: stamp },
			result: { available: true, filename: "offbalance-demo-result.txt", hash: "demo-result-hash", receiptMode: "offchain", receiptVerified: false },
		},
	];
	const submissions = new Map();
	return {
		setToken() {},
		getConfig: async () => ({ executionMode: "demo", chain: null }),
		demoLogin: async () => ({
			token: "local-demo-only",
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
			account: { id: "demo", wallet },
		}),
		listJobs: async (view) => ({
			jobs: structuredClone(
				view === "provider"
					? jobs.filter((job) => job.providerCount)
					: jobs,
			),
			summary:
				view === "buyer"
					? {
							activeJobs: jobs.filter(
								(job) => job.status !== "COMPLETED",
							).length,
							completedJobs: 1,
							totalSpent: "0.004",
						}
					: {
							activeJobs: 2,
							completedJobs: 1,
							totalEarned: "0.003",
							currentStake: provider.currentStake,
						},
		}),
		createJob: async (input, key) => {
			if (submissions.has(key))
				return structuredClone(submissions.get(key));
			const job = normalizeJob({
				...input,
				dockerImage: input.image ?? input.dockerImageDigest ?? input.dockerImage,
				executionMode: "demo",
				id: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
				status: "PENDING",
				providerCount: 0,
			});
			jobs = [job, ...jobs];
			const response = { job };
			submissions.set(key, response);
			return structuredClone(response);
		},
		getJob: async (id) => {
			const job = jobs.find((item) => item.id === id);
			if (!job) throw new Error("Job not found.");
			return { job: structuredClone(job) };
		},
		getResult: async (id) => {
			const job = jobs.find((item) => item.id === id);
			if (!job) throw new Error("Job not found.");
			if (!job.result?.available) throw new Error("No verified result is available.");
			return new Blob(["OffBalance demo result\n"], { type: "text/plain" });
		},
		getProvider: async () => ({ provider: structuredClone(provider) }),
		getProviderTutorial: async () => ({
			tutorial: {
				title: "Client setup",
				steps: [
					"Install the provider client when a release is available.",
					"Configure your wallet, coordinator address, and VM resources in the client.",
					"Start the client to register and report benchmark scores.",
					"Set an hourly price here. The coordinator assigns jobs automatically.",
				],
			},
		}),
		saveProviderPricing: async ({ pricePerHour }) => {
			provider = { ...provider, pricePerHour };
			return { provider: structuredClone(provider) };
		},
	};
}
