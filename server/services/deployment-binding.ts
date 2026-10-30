import mongoose, { Schema, type Connection } from "mongoose";

export type DeploymentIdentity = { chainId: number; address: string; genesisHash: string };
const bindingSchema = new Schema({
	_id: { type: String, required: true },
	chainId: { type: Number, required: true },
	address: { type: String, required: true },
	genesisHash: { type: String, required: true },
}, { versionKey: false });

/** A database belongs to one chain deployment; numeric job IDs are scoped to it. */
export async function bindDatabaseDeployment(identity: DeploymentIdentity, connection: Connection = mongoose.connection): Promise<void> {
	if (!Number.isSafeInteger(identity.chainId) || identity.chainId < 1 || !/^0x[0-9a-f]{40}$/i.test(identity.address) || !/^0x[0-9a-f]{64}$/i.test(identity.genesisHash)) {
		throw new TypeError("A valid chain ID, contract address and genesis hash are required for database binding.");
	}
	const address = identity.address.toLowerCase();
	const genesisHash = identity.genesisHash.toLowerCase();
	const model = connection.model("DeploymentBinding", bindingSchema);
	const binding = await model.findOneAndUpdate({ _id: "execution" }, {
		$setOnInsert: { chainId: identity.chainId, address, genesisHash },
	}, { upsert: true, returnDocument: "after", writeConcern: { w: "majority", j: true } });
	if (!binding || binding.chainId !== identity.chainId || binding.address !== address || binding.genesisHash !== genesisHash) {
		throw new Error(`Database belongs to chain ${binding?.chainId} contract ${binding?.address} genesis ${binding?.genesisHash}; refusing recovery against chain ${identity.chainId} contract ${address} genesis ${genesisHash}. Use a dedicated database for each deployment.`);
	}
}
