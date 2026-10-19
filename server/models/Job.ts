import { Query, Schema, model, type InferSchemaType } from "mongoose";
import { money } from "./decimal.ts";
import { JOB_STATUSES, JobStatus } from "./JobStatus.ts";

const jobRequirementsSchema = new Schema(
	{
		minCpuScore: { type: Number, default: 0, min: 0 },
		minGpuScore: { type: Number, default: 0, min: 0 },
		minMemoryScore: { type: Number, default: 0, min: 0 },
	},
	{ _id: false },
);

// What one provider delivered. Payment is conditioned on delivery, so each
// provider's receipt is tracked separately.
const providerResultSchema = new Schema(
	{
		provider: { type: Schema.Types.ObjectId, ref: "Account", required: true },
		hash: { type: String, required: true },
		deliveryTime: { type: Date, required: true },
		location: { type: String, required: true }, // where the output lives in object storage
		receiptVerified: { type: Boolean, default: false }, // verifyReceipt() went through on-chain
	},
	{ _id: false },
);

const jobSchema = new Schema(
	{
		// the id used everywhere else: contract calls, events, the client's /jobManifest/:jobId
		onChainJobId: { type: Number, required: true, unique: true, min: 0 },
		name: { type: String, trim: true, maxlength: 120, default: "" },
		requestKey: { type: String },
		requestHash: { type: String },
		owner: { type: Schema.Types.ObjectId, ref: "Account", required: true },
		status: { type: String, enum: JOB_STATUSES, default: JobStatus.PENDING },
		submittedAt: { type: Date, default: null }, // JOB_SUBMITTED seen on-chain; only then is it matched
		providers: { type: [{ type: Schema.Types.ObjectId, ref: "Account" }], default: [] },

		dockerImageDigest: {
			type: String,
			required: true,
			// pinned by digest so every provider runs byte-identical code
			match: /@sha256:[0-9a-f]{64}$/,
		},
		command: { type: [String], default: [] }, // empty = the image's own CMD
		env: { type: Map, of: String, default: () => new Map() },
		inputUrl: { type: String, default: null },
		cpuLimit: { type: Number, default: 1, min: 0 }, // cores
		memLimitMb: { type: Number, default: 512, min: 1 },

		maxPrice: money({ required: true }), // highest per-hour rate the buyer pays each provider
		runningPrice: money({ default: 0 }), // clearing rate: the priciest assigned provider's rate
		minNodesToRunOn: { type: Number, required: true, min: 1, validate: Number.isSafeInteger }, // k
		minNodesToAgree: {
			type: Number,
			required: true,
			min: 1,
			validate: {
				// `this` is the document on save, the query on update with runValidators
				validator(this: { minNodesToRunOn?: number } | Query<unknown, unknown>, v: number) {
					let k: number | undefined;
					if (this instanceof Query) {
						const u = (this.getUpdate() ?? {}) as Record<string, Record<string, number> | number>;
						k = (u.$set as Record<string, number>)?.minNodesToRunOn ??
							(u.$setOnInsert as Record<string, number>)?.minNodesToRunOn ??
							(u.minNodesToRunOn as number | undefined);
					} else {
						k = this.minNodesToRunOn;
					}
					return Number.isSafeInteger(v) && (k === undefined || v <= k);
				},
				message: "minNodesToAgree can't exceed minNodesToRunOn",
			},
		}, // quorum
		timeWindow: { type: Number, required: true, min: 1, validate: Number.isSafeInteger }, // seconds
		requirements: { type: jobRequirementsSchema, default: () => ({}) },
		results: { type: [providerResultSchema], default: [] },
	},
	{ timestamps: { createdAt: true, updatedAt: false } },
);

jobSchema.index({ owner: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: "string" } } });
jobSchema.index({ owner: 1, createdAt: -1 }); // dashboard: my jobs, newest first
jobSchema.index({ status: 1 }); // matcher / event listener lookups
jobSchema.index({ providers: 1, status: 1 }); // provider's jobs, busy check

export type Job = InferSchemaType<typeof jobSchema>;
export const JobModel = model("Job", jobSchema);
