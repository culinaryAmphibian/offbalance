import { Schema, model, type InferSchemaType } from "mongoose";
import { decimalString } from "./decimal.ts";

// A provider's machine: the hardware profile from the client's POST /scores
// (client/benchmark/, validated by services/hardware.ts parseProfile).
const gpuSchema = new Schema(
	{
		vendor: { type: String, enum: ["nvidia", "amd"], required: true },
		index: { type: Number, required: true, min: 0 }, // the vendor tool's device index on the provider
		model: { type: String, required: true },
		vramGb: { type: Number, required: true, min: 0 },
		driver: { type: String, default: null },
		runtime: { type: String, default: null }, // e.g. "CUDA 12.4"
		fp32Tflops: { type: Number, default: null, min: 0 },
		memoryBandwidthGBps: { type: Number, default: null, min: 0 },
		error: { type: String, default: null }, // set when the benchmark couldn't use it: not offered for jobs
	},
	{ _id: false },
);

const hardwareSchema = new Schema(
	{
		userRef: { type: Schema.Types.ObjectId, ref: "Account", required: true, unique: true },
		// the wallet the provider client signs with (the one its API key was issued to);
		// this is the address the server assigns on-chain
		address: { type: String, lowercase: true, match: /^0x[0-9a-f]{40}$/, required: true },

		cpu: {
			type: new Schema({
				model: { type: String, required: true },
				cores: { type: Number, required: true, min: 1 },
				threads: { type: Number, required: true, min: 1, validate: Number.isSafeInteger }, // = vCPUs
				singleThreadMBps: { type: Number, required: true, min: 0 }, // zlib compression throughput
				multiThreadMBps: { type: Number, required: true, min: 0 },
			}, { _id: false }),
			required: true,
		},
		memory: {
			type: new Schema({
				totalGb: { type: Number, required: true, min: 0 }, // GiB usable by the OS
				bandwidthGBps: { type: Number, required: true, min: 0 }, // copy bandwidth
			}, { _id: false }),
			required: true,
		},
		gpus: { type: [gpuSchema], default: [] },
		price: { type: Number, default: null, min: 0, validate: (value: number | null) => {
			try { if (value != null) decimalString(value); return true; } catch { return false; }
		} }, // per hour, set by the provider; unpriced machines aren't matched
	},
	// updatedAt drives the "update your pricing after your specs change" reminder
	{ timestamps: { createdAt: false, updatedAt: true } },
);

// the matcher filters on capacity
hardwareSchema.index({ "cpu.threads": 1, "memory.totalGb": 1 });

export type Hardware = InferSchemaType<typeof hardwareSchema>;
export const HardwareModel = model("Hardware", hardwareSchema);
