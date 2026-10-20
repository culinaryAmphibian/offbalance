import mongoose, { Schema, type Connection } from "mongoose";
import type { Checkpoint, CheckpointStore } from "../blockchain-manager/index.ts";

const checkpointSchema = new Schema({
	_id: { type: String, required: true },
	blockNumber: { type: Number, required: true, min: -1 },
	blockHash: { type: String, default: null },
}, { versionKey: false });

function validate(checkpoint: Checkpoint): void {
	if (!Number.isSafeInteger(checkpoint.blockNumber) || checkpoint.blockNumber < -1 ||
		(checkpoint.blockNumber === -1 ? checkpoint.blockHash !== null :
			typeof checkpoint.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(checkpoint.blockHash))) {
		throw new TypeError("Invalid blockchain checkpoint.");
	}
}

/** One persisted cursor per chain and contract; database connections stay caller-owned. */
export class MongoCheckpointStore implements CheckpointStore {
	readonly namespace: string;
	private readonly model;

	constructor(namespace: string, connection: Connection = mongoose.connection) {
		if (!namespace.trim()) throw new TypeError("A checkpoint namespace is required.");
		this.namespace = namespace;
		this.model = connection.model("BlockchainCheckpoint", checkpointSchema);
	}

	async load(): Promise<Checkpoint | null> {
		const row = await this.model.findById(this.namespace).lean().exec();
		if (!row) return null;
		const checkpoint = { blockNumber: row.blockNumber, blockHash: row.blockHash ?? null };
		validate(checkpoint);
		return checkpoint;
	}

	async save(checkpoint: Checkpoint): Promise<void> {
		validate(checkpoint);
		await this.model.updateOne({ _id: this.namespace }, {
			$set: { blockNumber: checkpoint.blockNumber, blockHash: checkpoint.blockHash },
		}, { upsert: true, runValidators: true }).exec();
	}
}

export function checkpointNamespace(chainId: number | bigint, address: string): string {
	return `${chainId}:${address.toLowerCase()}`;
}
