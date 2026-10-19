import { createHash, randomBytes } from "node:crypto";
import { Schema, model, type InferSchemaType } from "mongoose";

// A bearer token: the web app's session and the provider client's API key are
// the same thing. Only the hash is stored.
const authTokenSchema = new Schema(
	{
		tokenHash: { type: String, required: true, unique: true },
		account: { type: Schema.Types.ObjectId, ref: "Account", required: true, index: true },
		wallet: { type: String, lowercase: true, required: true }, // the wallet that signed in
	},
	{ timestamps: { createdAt: true, updatedAt: false } },
);

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
	return randomBytes(32).toString("base64url");
}

export type AuthToken = InferSchemaType<typeof authTokenSchema>;
export const AuthTokenModel = model("AuthToken", authTokenSchema);
