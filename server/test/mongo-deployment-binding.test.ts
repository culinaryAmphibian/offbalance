import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { bindDatabaseDeployment } from "../services/deployment-binding.ts";

const uri = process.env.MONGODB_URI;
test("a database durably pins one deployment and rejects different chain/contract before recovery", { skip: !uri }, async () => {
	const connection = await mongoose.createConnection(uri!, { dbName: `offbalance_deployment_${randomUUID().replaceAll("-", "")}` }).asPromise();
	const first = { chainId: 31337, address: `0x${"ab".repeat(20)}`, genesisHash: `0x${"cd".repeat(32)}` };
	try {
		await bindDatabaseDeployment(first, connection);
		await bindDatabaseDeployment({ ...first, address: first.address.toUpperCase().replace("0X", "0x"), genesisHash: first.genesisHash.toUpperCase().replace("0X", "0x") }, connection);
		const model = connection.model("DeploymentBinding");
		assert.equal(await model.countDocuments(), 1);
		const persisted = (await model.findById("execution").lean())!;
		assert.equal(persisted.chainId, first.chainId);
		assert.equal(persisted.address, first.address);
		assert.equal(persisted.genesisHash, first.genesisHash);
		for (const changed of [{ ...first, chainId: 1 }, { ...first, address: `0x${"cd".repeat(20)}` }, { ...first, genesisHash: `0x${"ef".repeat(32)}` }]) {
			let recovered = false;
			await assert.rejects(async () => {
				// Startup uses this guard before journal/claim/timer recovery.
				await bindDatabaseDeployment(changed, connection);
				recovered = true;
			}, /refusing recovery.*dedicated database/);
			assert.equal(recovered, false);
			assert.deepEqual(await model.findById("execution").lean(), persisted);
		}
		await assert.rejects(bindDatabaseDeployment({ ...first, chainId: 0 }, connection), TypeError);
		await assert.rejects(bindDatabaseDeployment({ ...first, address: "invalid" }, connection), TypeError);
		await assert.rejects(bindDatabaseDeployment({ ...first, genesisHash: "invalid" }, connection), TypeError);
	} finally {
		await connection.dropDatabase();
		await connection.close();
	}
});

test("concurrent startup cannot replace a database deployment binding", { skip: !uri }, async () => {
	const connection = await mongoose.createConnection(uri!, { dbName: `offbalance_deployment_race_${randomUUID().replaceAll("-", "")}` }).asPromise();
	try {
		const identities = ["1", "2"].map(digit => ({ chainId: 31337, address: `0x${digit.repeat(40)}`, genesisHash: `0x${"a".repeat(64)}` }));
		const results = await Promise.allSettled(identities.map(identity => bindDatabaseDeployment(identity, connection)));
		assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
		assert.equal(results.filter(result => result.status === "rejected").length, 1);
		const winner = identities[results.findIndex(result => result.status === "fulfilled")];
		await bindDatabaseDeployment(winner, connection);
		assert.equal(await connection.model("DeploymentBinding").countDocuments(), 1);
	} finally {
		await connection.dropDatabase();
		await connection.close();
	}
});
