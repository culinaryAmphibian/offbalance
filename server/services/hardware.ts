// Hardware profiles from the provider client's benchmark (client/benchmark/), and what the
// server derives from them: scores relative to a reference machine, the specs the matcher
// checks, and the suggested hourly price.
import { config } from "../config.ts";
import { decimalString } from "../models/decimal.ts";
import type { MachineSpecs } from "../matching/types.ts";

export const PROFILE_VERSION = 2;

export interface GpuProfile {
	vendor: "nvidia" | "amd";
	index: number;
	model: string;
	vramGb: number;
	driver: string | null;
	runtime: string | null;
	fp32Tflops: number | null;
	memoryBandwidthGBps: number | null;
	error: string | null; // the benchmark container couldn't use it; not offered for jobs
}

export interface HardwareProfile {
	cpu: { model: string; cores: number; threads: number; singleThreadMBps: number; multiThreadMBps: number };
	memory: { totalGb: number; bandwidthGBps: number };
	gpus: GpuProfile[];
}

// 1.0x on every relative score. CPU and memory were measured with the client's own benchmark
// on an Intel Core i7-9700K limited to 4 threads with dual-channel DDR4. The GPU is an NVIDIA
// RTX 2070 as the client's benchmark would measure it: its spec sheet (7.5 TFLOPS, 448 GB/s)
// scaled by what a measured Turing card (RTX 2080 SUPER: 9.80 of 11.15 TFLOPS, 392 of 496 GB/s)
// reaches, so a real card isn't scored against a peak no card hits.
export const REFERENCE = {
	description: "Intel Core i7-9700K (4 cores), 16 GB dual-channel DDR4, NVIDIA GeForce RTX 2070",
	cpuSingleThreadMBps: 45,
	cpuMultiThreadMBps: 164,
	memoryGb: 16,
	memoryBandwidthGBps: 9.8,
	gpuVramGb: 8,
	gpuFp32Tflops: 6.6,
	gpuMemoryBandwidthGBps: 354,
} as const;

export class ProfileError extends Error {}

const OLD_CLIENT = "This provider client sends the old benchmark format. Update the client (git pull) and restart it.";

function num(value: unknown, path: string, { integer = false, positive = false, max = 1e9 } = {}): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max ||
		(positive && value === 0) || (integer && !Number.isSafeInteger(value))) {
		throw new ProfileError(`${path} must be a ${positive ? "positive" : "non-negative"} ${integer ? "integer" : "number"}`);
	}
	return value;
}

function text(value: unknown, path: string, maxLength: number, { optional = false } = {}): string | null {
	if (optional && (value === null || value === undefined)) return null;
	if (typeof value !== "string" || !value.trim()) throw new ProfileError(`${path} must be a non-empty string`);
	return value.trim().slice(0, maxLength);
}

function optionalNum(value: unknown, path: string): number | null {
	return value === null || value === undefined ? null : num(value, path);
}

/** The profile POST /scores sent, validated; throws ProfileError with a message for the client. */
export function parseProfile(body: unknown): HardwareProfile {
	const data = (body ?? {}) as Record<string, any>;
	if (data.version !== PROFILE_VERSION || typeof data.cpu !== "object" || data.cpu === null) {
		throw new ProfileError(OLD_CLIENT);
	}
	if (typeof data.memory !== "object" || data.memory === null) throw new ProfileError("memory is required");
	if (!Array.isArray(data.gpus) || data.gpus.length > 16) throw new ProfileError("gpus must be a list of at most 16 GPUs");
	const { cpu, memory } = data;
	const threads = num(cpu.threads, "cpu.threads", { integer: true, positive: true, max: 4096 });
	return {
		cpu: {
			model: text(cpu.model, "cpu.model", 200)!,
			cores: Math.min(num(cpu.cores, "cpu.cores", { integer: true, positive: true, max: 4096 }), threads),
			threads,
			singleThreadMBps: num(cpu.singleThreadMBps, "cpu.singleThreadMBps"),
			multiThreadMBps: num(cpu.multiThreadMBps, "cpu.multiThreadMBps"),
		},
		memory: {
			totalGb: num(memory.totalGb, "memory.totalGb", { positive: true, max: 1e6 }),
			bandwidthGBps: num(memory.bandwidthGBps, "memory.bandwidthGBps"),
		},
		gpus: data.gpus.map((gpu: Record<string, any>, i: number) => {
			const path = `gpus[${i}]`;
			if (gpu?.vendor !== "nvidia" && gpu?.vendor !== "amd") throw new ProfileError(`${path}.vendor must be nvidia or amd`);
			const error = text(gpu.error, `${path}.error`, 500, { optional: true });
			const fp32Tflops = optionalNum(gpu.fp32Tflops, `${path}.fp32Tflops`);
			return {
				vendor: gpu.vendor,
				index: num(gpu.index, `${path}.index`, { integer: true, max: 1024 }),
				model: text(gpu.model, `${path}.model`, 200)!,
				vramGb: num(gpu.vramGb, `${path}.vramGb`, { max: 1e5 }),
				driver: text(gpu.driver, `${path}.driver`, 64, { optional: true }),
				runtime: text(gpu.runtime, `${path}.runtime`, 32, { optional: true }),
				fp32Tflops,
				memoryBandwidthGBps: optionalNum(gpu.memoryBandwidthGBps, `${path}.memoryBandwidthGBps`),
				// a GPU without a measurement can't be shown to work, whatever the client says
				error: error ?? (fp32Tflops === null ? "not benchmarked" : null),
			};
		}),
	};
}

export const usableGpus = (profile: HardwareProfile) => profile.gpus.filter(gpu => gpu.error === null && gpu.fp32Tflops !== null);

/** What the matcher compares against a job's requirements. Only GPUs that benchmarked count. */
export function machineSpecs(profile: HardwareProfile): MachineSpecs {
	return {
		vcpus: profile.cpu.threads,
		memoryGb: profile.memory.totalGb,
		gpus: usableGpus(profile).map(gpu => ({ vendor: gpu.vendor, vramGb: gpu.vramGb })),
	};
}

const ratio = (value: number | null | undefined, reference: number) => value == null ? null : Math.round(value / reference * 100) / 100;

/** Each measurement as a multiple of REFERENCE (1.0 = the reference machine). */
export function relativeScores(profile: HardwareProfile) {
	const best = usableGpus(profile).sort((a, b) => b.fp32Tflops! - a.fp32Tflops!)[0];
	return {
		cpuSingleThread: ratio(profile.cpu.singleThreadMBps, REFERENCE.cpuSingleThreadMBps),
		cpuMultiThread: ratio(profile.cpu.multiThreadMBps, REFERENCE.cpuMultiThreadMBps),
		memoryBandwidth: ratio(profile.memory.bandwidthGBps, REFERENCE.memoryBandwidthGBps),
		gpuFp32: ratio(best?.fp32Tflops, REFERENCE.gpuFp32Tflops),
		gpuMemoryBandwidth: ratio(best?.memoryBandwidthGBps, REFERENCE.gpuMemoryBandwidthGBps),
		// one per entry of profile.gpus, in the same order; null for a GPU that didn't benchmark
		gpus: profile.gpus.map(gpu => ratio(gpu.error === null ? gpu.fp32Tflops : null, REFERENCE.gpuFp32Tflops)),
	};
}

export interface PriceItem {
	label: string;
	detail: string;
	pricePerHour: string; // ETH
}

// suggested prices are guidance, so 4 significant digits is plenty and keeps the numbers readable
const eth = (value: number) => decimalString(Number(value.toPrecision(4)));

/** Spec-based suggestion: vCPUs (scaled by per-thread speed), memory, and each usable GPU's TFLOPS. */
export function formulaPrice(profile: HardwareProfile, rates = config.pricing) {
	const speed = Math.min(2, Math.max(0.5, profile.cpu.singleThreadMBps / REFERENCE.cpuSingleThreadMBps));
	const items: PriceItem[] = [];
	let total = 0;
	const add = (label: string, detail: string, amount: number) => {
		total += amount;
		items.push({ label, detail, pricePerHour: eth(amount) });
	};
	add("CPU", `${profile.cpu.threads} vCPUs × ${speed.toFixed(2)}× reference speed × ${rates.vcpuHourEth} ETH`,
		profile.cpu.threads * speed * rates.vcpuHourEth);
	add("Memory", `${profile.memory.totalGb.toFixed(1)} GB × ${rates.gbHourEth} ETH`, profile.memory.totalGb * rates.gbHourEth);
	for (const gpu of usableGpus(profile)) {
		add(`GPU ${gpu.index}`, `${gpu.model}: ${gpu.fp32Tflops!.toFixed(1)} TFLOPS × ${rates.tflopsHourEth} ETH`,
			gpu.fp32Tflops! * rates.tflopsHourEth);
	}
	return { pricePerHour: eth(total), items };
}

const within = (value: number, target: number, tolerance = 0.25) => value >= target * (1 - tolerance) && value <= target * (1 + tolerance);

/** Machines comparable enough that their prices say something about this one's. */
export function similarMachines(profile: HardwareProfile, others: HardwareProfile[]): HardwareProfile[] {
	const gpuModels = (p: HardwareProfile) => usableGpus(p).map(gpu => gpu.model).sort().join("\n");
	const mine = gpuModels(profile);
	return others.filter(other => within(other.cpu.threads, profile.cpu.threads) &&
		within(other.memory.totalGb, profile.memory.totalGb) && gpuModels(other) === mine);
}
