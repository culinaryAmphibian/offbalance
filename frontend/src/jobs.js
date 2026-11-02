import { convertBudget } from "./budget.js";

export const statusLabel = (status) =>
	String(status || "UNKNOWN")
		.toLowerCase()
		.replaceAll("_", " ")
		.replace(/^./, (letter) => letter.toUpperCase());
export const shortWallet = (wallet) =>
	`${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
export const dateLabel = (date) =>
	date && Number.isFinite(Date.parse(date))
		? new Date(date).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			})
		: "—";
export const timeLabel = (date) =>
	date && Number.isFinite(Date.parse(date))
		? new Date(date).toLocaleString()
		: "Not reported";

const phases = {
	PENDING: ["pending", "Waiting for provider assignment."],
	PICKED_UP: ["pending", "Providers are accepting the assignment."],
	RUNNING: ["running", "Providers are executing the container."],
	COMMIT_PHASE: [
		"running",
		"Providers are executing and committing their result hashes.",
	],
	REVEAL_PHASE: [
		"verifying",
		"Providers are revealing their committed results.",
	],
	VERIFYING: [
		"verifying",
		"Result commitments and reveals are being checked.",
	],
	CONSENSUS_VERIFICATION: [
		"verifying",
		"Checking whether enough providers agree.",
	],
	AWAITING_DELIVERY: ["pending", "Waiting for the agreed output to arrive."],
	DELIVERY_RECEIPT_VALIDATION: [
		"verifying",
		"Checking the output’s delivery receipt.",
	],
	PAYOUT: [
		"verifying",
		"Payment is being processed. Settlement is reported separately below.",
	],
	COMPLETED: [
		"completed",
		"Execution is complete. Delivery and payment are reported separately below.",
	],
	CANCELED: ["canceled", "This job was canceled."],
	CANCELLED: ["canceled", "This job was canceled."],
	NO_QUORUM: ["failed", "Providers did not reach the required agreement."],
	FAILED: ["failed", "This job failed."],
};
export const jobPhase = (status) =>
	phases[status] || ["pending", "The server has reported a new job phase."];

// Keep the UI shape stable while accepting the database API field names.
export function normalizeJob(job) {
	if (!job || typeof job !== "object")
		throw new Error("The API returned an invalid job.");
	const id = job.id ?? job._id?.$oid ?? job._id;
	if (!["string", "number"].includes(typeof id) || String(id) === "")
		throw new Error("The API returned a job without an ID.");
	const normalized = {
		...job,
		id: String(id),
		dockerImage: job.dockerImage ?? job.dockerImageDigest,
		k: job.k ?? job.minNodesToRunOn,
		quorum: job.quorum ?? job.minNodesToAgree,
		window: job.window ?? job.timeWindow,
		providerCount:
			job.providerCount ??
			(Array.isArray(job.providers) ? job.providers.length : undefined),
		resultHash: job.resultHash ?? job.result?.hash,
		...(job.delivery || job.result?.deliveryTime
			? {
					delivery: {
						...job.delivery,
						receivedAt:
							job.delivery?.receivedAt ??
							job.result?.deliveryTime,
					},
				}
			: {}),
	};
	return Object.fromEntries(
		Object.entries(normalized).filter(([, value]) => value !== undefined),
	);
}

export function validateJob(values, usdPerEth = null) {
	const errors = {};
	if (!values.name.trim()) errors.name = "Enter a job name.";
	if (!values.dockerImage.trim() || /\s/.test(values.dockerImage.trim()))
		errors.dockerImage =
			"Enter a container image reference without spaces.";
	try {
		convertBudget(
			values.maxPrice,
			values.budgetCurrency ?? "ETH",
			usdPerEth,
		);
	} catch (error) {
		errors.maxPrice = error.message;
	}
	const whole = (field, minimum) =>
		/^\d+$/.test(values[field]) &&
		Number.isSafeInteger(Number(values[field])) &&
		Number(values[field]) >= minimum;
	for (const field of ["k", "quorum", "window", "vcpus"]) {
		if (!whole(field, 1)) errors[field] = "Enter a whole number of 1 or more.";
	}
	if (!errors.vcpus && Number(values.vcpus) > MAX_VCPUS)
		errors.vcpus = `Enter ${MAX_VCPUS} vCPUs or fewer.`;
	if (
		!/^\d+(?:\.\d{1,2})?$/.test(values.memoryGb ?? "") ||
		Number(values.memoryGb) < MIN_MEMORY_GB ||
		Number(values.memoryGb) > MAX_MEMORY_GB
	)
		errors.memoryGb = `Enter ${MIN_MEMORY_GB}–${MAX_MEMORY_GB} GB, with up to 2 decimal places.`;
	if (!GPU_OPTIONS.some(([value]) => value === values.gpu))
		errors.gpu = "Choose a GPU option.";
	else if (values.gpu !== "none" && (!whole("gpuVram", 0) || Number(values.gpuVram) > MAX_VRAM_GB))
		errors.gpuVram = `Enter a whole number of GB from 0 to ${MAX_VRAM_GB}.`;
	for (const field of ["k", "quorum"]) {
		if (!errors[field] && Number(values[field]) > 255)
			errors[field] = "Enter a value of 255 or less.";
	}
	if (!errors.window && Number(values.window) > 10080)
		errors.window = "Enter an execution window of 1–10080 minutes.";
	if (!errors.quorum && !errors.k && Number(values.quorum) > Number(values.k))
		errors.quorum = "Agreement cannot exceed the provider count.";
	return errors;
}

export function jobPayload(values, usdPerEth = null) {
	return {
		name: values.name.trim(),
		...(/@sha256:[0-9a-f]{64}$/.test(values.dockerImage.trim())
			? { dockerImageDigest: values.dockerImage.trim() }
			: { image: values.dockerImage.trim() }),
		maxPrice: convertBudget(
			values.maxPrice,
			values.budgetCurrency ?? "ETH",
			usdPerEth,
		),
		minNodesToRunOn: Number(values.k),
		minNodesToAgree: Number(values.quorum),
		timeWindow: Number(values.window) * 60,
		// the provider's container gets exactly this: the server derives its Docker limits from it
		requirements: {
			minVcpus: Number(values.vcpus),
			minMemoryGb: Number(values.memoryGb),
			gpu: values.gpu,
			minGpuVramGb: values.gpu === "none" ? 0 : Number(values.gpuVram),
		},
	};
}
// limits match server/models/Job.ts
export const MAX_VCPUS = 1024;
export const MIN_MEMORY_GB = 0.25;
export const MAX_MEMORY_GB = 4096;
export const MAX_VRAM_GB = 1024;
export const GPU_OPTIONS = [
	["none", "No GPU"],
	["any", "Any GPU (NVIDIA or AMD)"],
	["nvidia", "NVIDIA GPU (CUDA)"],
	["amd", "AMD GPU (ROCm)"],
];

/** "2 vCPUs · 4 GB memory · NVIDIA GPU with 8 GB+ VRAM" for a job's requirements. */
export function resourceSummary(requirements) {
	if (!requirements) return "—";
	const { minVcpus, minMemoryGb, gpu = "none", minGpuVramGb = 0 } = requirements;
	const parts = [];
	if (minVcpus != null) parts.push(`${minVcpus} vCPU${Number(minVcpus) === 1 ? "" : "s"}`);
	if (minMemoryGb != null) parts.push(`${minMemoryGb} GB memory`);
	if (gpu === "none") parts.push("no GPU");
	else {
		const vendor = gpu === "any" ? "" : `${gpu === "nvidia" ? "NVIDIA" : "AMD"} `;
		parts.push(`${vendor}GPU${Number(minGpuVramGb) > 0 ? ` with ${minGpuVramGb} GB+ VRAM` : ""}`);
	}
	return parts.join(" · ");
}

export function windowMinutes(seconds) {
	return Number.isFinite(seconds) && seconds > 0
		? String(Number((seconds / 60).toFixed(6)))
		: "—";
}

// Output URLs are supplied by providers. Never execute scripts or forward API credentials.
export function resultUrl(value) {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}
