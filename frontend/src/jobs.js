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

// Lucidchart and repository UML use different names for the same job fields.
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
	for (const field of [
		"k",
		"quorum",
		"window",
		"minCpuScore",
		"minGpuScore",
		"minMemoryScore",
	]) {
		const minimum = field.startsWith("min") ? 0 : 1;
		if (
			!/^\d+$/.test(values[field]) ||
			!Number.isSafeInteger(Number(values[field])) ||
			Number(values[field]) < minimum
		)
			errors[field] = `Enter a whole number of ${minimum} or more.`;
	}
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
		dockerImage: values.dockerImage.trim(),
		maxPrice: convertBudget(
			values.maxPrice,
			values.budgetCurrency ?? "ETH",
			usdPerEth,
		),
		k: Number(values.k),
		quorum: Number(values.quorum),
		window: Number(values.window) * 60,
		requirements: Object.fromEntries(
			["minCpuScore", "minGpuScore", "minMemoryScore"].map((field) => [
				field,
				Number(values[field]),
			]),
		),
	};
}
export function windowMinutes(seconds) {
	return Number.isFinite(seconds) && seconds > 0
		? String(Number((seconds / 60).toFixed(6)))
		: "—";
}
