import { Schema, model, type InferSchemaType } from "mongoose";
import { decimalString } from "./decimal.ts";

// A provider's benchmarked machine. Scores come from the client's POST /scores.
const hardwareSchema = new Schema(
	{
		userRef: { type: Schema.Types.ObjectId, ref: "Account", required: true, unique: true },
		// the wallet the provider client signs with (the one its API key was issued to);
		// this is the address the server assigns on-chain
		address: { type: String, lowercase: true, match: /^0x[0-9a-f]{40}$/, required: true },

		cpuScore: { type: Number, required: true, min: 0 },
		gpuScore: { type: Number, default: null, min: 0 }, // null when the machine has no GPU
		memoryScore: { type: Number, required: true, min: 0 },
		price: { type: Number, default: null, min: 0, validate: (value: number | null) => {
			try { if (value != null) decimalString(value); return true; } catch { return false; }
		} }, // per hour, set by the provider; unpriced machines aren't matched
	},
	// updatedAt drives the "update your pricing after your specs change" reminder
	{ timestamps: { createdAt: false, updatedAt: true } },
);

// the matcher filters on minimum specs
hardwareSchema.index({ cpuScore: 1, gpuScore: 1, memoryScore: 1 });

export type Hardware = InferSchemaType<typeof hardwareSchema>;
export const HardwareModel = model("Hardware", hardwareSchema);
