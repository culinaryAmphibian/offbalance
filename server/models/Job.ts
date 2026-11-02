import { Query, Schema, model, type InferSchemaType } from "mongoose";
import { money } from "./decimal.ts";
import { JOB_STATUSES, JobStatus } from "./JobStatus.ts";

// What the job's container gets on the provider; the matcher only picks machines that have it.
const jobRequirementsSchema = new Schema(
	{
		minVcpus: { type: Number, default: 1, min: 1, max: 1024, validate: Number.isSafeInteger }, // logical CPUs
		minMemoryGb: { type: Number, default: 1, min: 0.25, max: 4096 }, // GiB
		gpu: { type: String, enum: ["none", "any", "nvidia", "amd"], default: "none" },
		minGpuVramGb: { type: Number, default: 0, min: 0, max: 1024 }, // GiB; only with a GPU
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
		contentVerified: { type: Boolean, default: false },
		receiptMode: { type: String, enum: ["local", "offchain", "onchain"] },
		archiveHash: { type: String },
		size: { type: Number, min: 0 },
		filename: { type: String },
		retainedUntil: { type: Date },
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
		// Docker limits the provider enforces; always derived from requirements (below)
		cpuLimit: { type: Number, default: 1, min: 0 }, // vCPUs
		memLimitMb: { type: Number, default: 1024, min: 1 },

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

// the container gets exactly what the matcher checked the provider has
jobSchema.pre("validate", function () {
	const requirements = this.requirements ?? { minVcpus: 1, minMemoryGb: 1 };
	this.cpuLimit = requirements.minVcpus ?? 1;
	this.memLimitMb = Math.round((requirements.minMemoryGb ?? 1) * 1024);
});

jobSchema.index({ owner: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: "string" } } });
jobSchema.index({ owner: 1, createdAt: -1 }); // dashboard: my jobs, newest first
jobSchema.index({ status: 1 }); // matcher / event listener lookups
jobSchema.index({ providers: 1, status: 1 }); // provider's jobs, busy check

export type Job = InferSchemaType<typeof jobSchema>;
export const JobModel = model("Job", jobSchema);
