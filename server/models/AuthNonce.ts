import { Schema, model, type InferSchemaType } from "mongoose";

export const NONCE_TTL_S = 5 * 60;

// One outstanding sign-in challenge per wallet; Mongo expires it.
const authNonceSchema = new Schema({
	wallet: { type: String, lowercase: true, required: true, unique: true },
	nonce: { type: String, required: true },
	createdAt: { type: Date, default: Date.now, expires: NONCE_TTL_S },
});

export function loginMessage(wallet: string, nonce: string): string {
	return `Sign in to OffBalance\n\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}`;
}

export type AuthNonce = InferSchemaType<typeof authNonceSchema>;
export const AuthNonceModel = model("AuthNonce", authNonceSchema);
