// Hardware profiles (services/hardware.ts): validation of what the client posts, the specs the
// matcher sees, relative scores and the suggested price. No database needed.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	formulaPrice, machineSpecs, parseProfile, ProfileError, REFERENCE, relativeScores, similarMachines,
	type HardwareProfile,
} from "../services/hardware.ts";

const RTX_2070 = { vendor: "nvidia", index: 0, model: "NVIDIA GeForce RTX 2070", vramGb: 8, driver: "550.54.14",
	runtime: "CUDA 12.4", fp32Tflops: 6.6, memoryBandwidthGBps: 354, error: null };
// the reference machine itself, as client/benchmark would report it
const REFERENCE_PROFILE = {
	version: 2,
	cpu: { model: "Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz", cores: 4, threads: 4, singleThreadMBps: 45, multiThreadMBps: 164 },
	memory: { totalGb: 16, bandwidthGBps: 9.8 },
	gpus: [RTX_2070],
};
const RATES = { vcpuHourEth: 0.00001, gbHourEth: 0.000001, tflopsHourEth: 0.00001 };
const profile = (changes: Record<string, unknown> = {}) => parseProfile({ ...REFERENCE_PROFILE, ...changes });

describe("parseProfile", () => {
	test("accepts the client's profile and trims text", () => {
		const parsed = profile({ cpu: { ...REFERENCE_PROFILE.cpu, model: "  Ryzen  " } });
		assert.equal(parsed.cpu.model, "Ryzen");
		assert.deepEqual(parsed.gpus[0], RTX_2070);
	});

	test("old clients' form scores and other versions get the update hint", () => {
		for (const body of [{ cpu: "1", mem: "1" }, {}, undefined, { ...REFERENCE_PROFILE, version: 1 }]) {
			assert.throws(() => parseProfile(body), /Update the client/);
		}
	});

	test("rejects impossible numbers and unknown vendors, naming the field", () => {
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ cpu: { ...REFERENCE_PROFILE.cpu, threads: 2.5 } }, /cpu\.threads/],
			[{ cpu: { ...REFERENCE_PROFILE.cpu, singleThreadMBps: -1 } }, /cpu\.singleThreadMBps/],
			[{ cpu: { ...REFERENCE_PROFILE.cpu, model: "" } }, /cpu\.model/],
			[{ memory: { totalGb: 0, bandwidthGBps: 1 } }, /memory\.totalGb/],
			[{ memory: { totalGb: Number.POSITIVE_INFINITY, bandwidthGBps: 1 } }, /memory\.totalGb/],
			[{ gpus: [{ ...RTX_2070, vendor: "intel" }] }, /gpus\[0\]\.vendor/],
			[{ gpus: [{ ...RTX_2070, vramGb: "8" }] }, /gpus\[0\]\.vramGb/],
			[{ gpus: Array(17).fill(RTX_2070) }, /at most 16/],
		];
		for (const [changes, message] of cases) assert.throws(() => profile(changes), (e: Error) => e instanceof ProfileError && message.test(e.message));
	});

	test("cores are capped at threads, and a GPU without a measurement is never usable", () => {
		assert.equal(profile({ cpu: { ...REFERENCE_PROFILE.cpu, cores: 64 } }).cpu.cores, 4);
		const [gpu] = profile({ gpus: [{ ...RTX_2070, fp32Tflops: null }] }).gpus;
		assert.equal(gpu.error, "not benchmarked");
	});
});

describe("derived values", () => {
	test("the matcher sees vCPUs, usable memory and only the GPUs that benchmarked", () => {
		const parsed = profile({ gpus: [RTX_2070, { ...RTX_2070, index: 1, fp32Tflops: null, error: "Docker can't use this GPU" }] });
		assert.deepEqual(machineSpecs(parsed), { vcpus: 4, memoryGb: 16, gpus: [{ vendor: "nvidia", vramGb: 8 }] });
	});

	test("the reference machine scores 1.0 everywhere; others scale linearly", () => {
		assert.deepEqual(relativeScores(profile()), {
			cpuSingleThread: 1, cpuMultiThread: 1, memoryBandwidth: 1, gpuFp32: 1, gpuMemoryBandwidth: 1, gpus: [1],
		});
		const fast = profile({
			cpu: { ...REFERENCE_PROFILE.cpu, threads: 16, cores: 8, singleThreadMBps: 67.5, multiThreadMBps: 820 },
			gpus: [{ ...RTX_2070, fp32Tflops: 3.3 }, { ...RTX_2070, index: 1, model: "RTX 4090", fp32Tflops: 72.6, memoryBandwidthGBps: 796.5 }],
		});
		const scores = relativeScores(fast);
		assert.equal(scores.cpuSingleThread, 1.5);
		assert.equal(scores.cpuMultiThread, 5);
		assert.equal(scores.gpuFp32, 11, "the fastest usable GPU is compared");
		assert.equal(scores.gpuMemoryBandwidth, 2.25);
		assert.deepEqual(scores.gpus, [0.5, 11]);
		assert.deepEqual(relativeScores(profile({ gpus: [{ ...RTX_2070, fp32Tflops: null, error: "no" }] })).gpus, [null]);
		assert.equal(relativeScores(profile({ gpus: [] })).gpuFp32, null);
	});

	test("the reference description names the RTX 2070", () => {
		assert.match(REFERENCE.description, /RTX 2070/);
	});

	test("formula price itemises vCPUs scaled by per-thread speed, memory and each usable GPU", () => {
		const price = formulaPrice(profile(), RATES);
		assert.deepEqual(price.items.map(item => [item.label, item.pricePerHour]), [
			["CPU", "0.00004"], ["Memory", "0.000016"], ["GPU 0", "0.000066"],
		]);
		assert.equal(price.pricePerHour, "0.000122");
		// twice the per-thread speed doubles the CPU part; speed is clamped to 0.5–2x
		const fast = formulaPrice(profile({ cpu: { ...REFERENCE_PROFILE.cpu, singleThreadMBps: 900 } }), RATES);
		assert.equal(fast.items[0].pricePerHour, "0.00008");
		assert.match(fast.items[0].detail, /4 vCPUs × 2\.00×/);
		const noGpu = formulaPrice(profile({ gpus: [{ ...RTX_2070, fp32Tflops: null, error: "no" }] }), RATES);
		assert.deepEqual(noGpu.items.map(item => item.label), ["CPU", "Memory"]);
	});

	test("similar machines have about the same vCPUs and memory and the same usable GPU models", () => {
		const base = profile();
		const others: HardwareProfile[] = [
			profile({ cpu: { ...REFERENCE_PROFILE.cpu, threads: 5, cores: 5 }, memory: { totalGb: 15.5, bandwidthGBps: 9 } }),
			profile({ cpu: { ...REFERENCE_PROFILE.cpu, threads: 8, cores: 8 } }),
			profile({ memory: { totalGb: 64, bandwidthGBps: 9 } }),
			profile({ gpus: [] }),
			profile({ gpus: [{ ...RTX_2070, model: "RTX 3090" }] }),
		];
		assert.deepEqual(similarMachines(base, others), [others[0]]);
	});
});
