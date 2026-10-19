import mongoose from "mongoose";
import { config } from "./config.ts";

export async function connectDB(uri = config.mongodbUri): Promise<typeof mongoose> {
	const conn = await mongoose.connect(uri);
	// build declared indexes (unique wallet, unique onChainJobId, ...)
	await mongoose.syncIndexes();
	return conn;
}

export function disconnectDB(): Promise<void> {
	return mongoose.disconnect();
}
