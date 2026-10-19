import { Schema, model, type InferSchemaType } from "mongoose";
import { money } from "./decimal.ts";

// One account can be both a buyer and a provider, and can link several wallets.
// Login is by wallet, so every account has at least one.
const accountSchema = new Schema(
	{
		walletIds: {
			type: [{ type: String, lowercase: true, match: /^0x[0-9a-f]{40}$/ }],
			validate: {
				validator: (v: string[]) => v.length > 0,
				message: "an account needs at least one wallet",
			},
		},

		processedChainEvents: { type: [String], default: [] },

		// buyer
		submittedJobs: { type: [{ type: Schema.Types.ObjectId, ref: "Job" }], default: [] },
		completedJobs: { type: [{ type: Schema.Types.ObjectId, ref: "Job" }], default: [] },
		totalSpent: money({ default: 0 }),

		// provider
		takenJobs: { type: [{ type: Schema.Types.ObjectId, ref: "Job" }], default: [] },
		totalEarned: money({ default: 0 }),
		currentStake: money({ default: 0 }),
		reputation: { type: Number, default: 0 },
		hardware: { type: Schema.Types.ObjectId, ref: "Hardware", default: null },
	},
	{ timestamps: true },
);

// a wallet belongs to at most one account
accountSchema.index({ walletIds: 1 }, { unique: true });

export type Account = InferSchemaType<typeof accountSchema>;
export const AccountModel = model("Account", accountSchema);
