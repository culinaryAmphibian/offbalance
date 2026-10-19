import { Schema, model, type InferSchemaType } from "mongoose";

export const BuildStatus = {
	QUEUED: "QUEUED",
	BUILDING: "BUILDING",
	PUSHING: "PUSHING",
	DONE: "DONE",
	FAILED: "FAILED",
} as const;
export type BuildStatus = (typeof BuildStatus)[keyof typeof BuildStatus];

// A buyer's Dockerfile, built once by the server and pushed to the registry, so
// every provider pulls the same image instead of building it themselves.
const buildSchema = new Schema(
	{
		owner: { type: Schema.Types.ObjectId, ref: "Account", required: true, index: true },
		status: { type: String, enum: Object.values(BuildStatus), default: BuildStatus.QUEUED },
		source: { type: String, enum: ["dockerfile", "context"], required: true }, // Dockerfile text, or a tar build context
		tag: { type: String, required: true }, // where it's pushed
		image: { type: String, default: null }, // pinned `registry/repo@sha256:...`, once DONE
		digest: { type: String, default: null },
		log: { type: String, default: "" }, // tail of the docker output
		error: { type: String, default: null },
		startedAt: { type: Date, default: null },
		finishedAt: { type: Date, default: null },
	},
	{ timestamps: { createdAt: true, updatedAt: false } },
);

export type Build = InferSchemaType<typeof buildSchema>;
export const BuildModel = model("Build", buildSchema);
