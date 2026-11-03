import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createResultStore, LocalResultStore, MAX_RESULT_BYTES, R2Budget, R2ResultStore, StorageError } from "../storage/results.ts";

const options = { accountId: "a".repeat(32), bucket: "offbalance-test", accessKeyId: "fake-access", secretAccessKey: "fake-secret" };
async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "offbalance-results-"));
	t.after(() => rm(dir, { force: true, recursive: true }));
	return dir;
}
function fakeClient(send: (command: unknown) => Promise<unknown>) { return { send } as unknown as Pick<S3Client, "send">; }

test("local results roundtrip, immutable keys, safe permissions, and idempotent cleanup", async t => {
	const dir = await sandbox(t);
	const store = new LocalResultStore(dir);
	await store.put("jobs/1/result.tar", Buffer.from("output"));
	assert.equal((await stat(path.join(dir, "jobs/1/result.tar"))).mode & 0o777, 0o600);
	const result = await store.get("jobs/1/result.tar");
	assert.equal(result.size, 6);
	assert.equal(await result.body.toArray().then(chunks => Buffer.concat(chunks).toString()), "output");
	await assert.rejects(store.put("jobs/1/result.tar", Buffer.from("new")), { status: 409 });
	await store.delete("jobs/1/result.tar");
	await store.delete("jobs/1/result.tar");
	await assert.rejects(store.get("jobs/1/result.tar"), { status: 404 });
});

test("local storage rejects traversal, oversized objects, and symlink downloads", async t => {
	const dir = await sandbox(t);
	const store = new LocalResultStore(dir);
	for (const key of ["../secret", "jobs/../secret", "/absolute", "a//b", "a\\b", "a/%2e%2e/b"]) {
		await assert.rejects(store.put(key, Buffer.from("x")), { status: 400 });
	}
	await assert.rejects(store.put("large", Buffer.alloc(MAX_RESULT_BYTES + 1)), { status: 413 });
	await writeFile(path.join(dir, "secret"), "secret");
	await symlink(path.join(dir, "secret"), path.join(dir, "result"));
	await assert.rejects(store.get("result"), StorageError);
});

test("storage factory defaults to local and never enables R2 implicitly", () => {
	assert.ok(createResultStore({}) instanceof LocalResultStore);
	assert.equal(createResultStore({ RESULT_STORAGE: "off" }), null);
	assert.throws(() => createResultStore({ ...options, RESULT_STORAGE: "r2" }), /disabled/);
	assert.throws(() => createResultStore({ RESULT_STORAGE: "anything" }), StorageError);
	assert.throws(() => createResultStore({ RESULT_STORAGE: "r2", R2_ENABLED: "true", R2_ACCOUNT_ID: "https://attacker.test" }), /configuration/);
});

test("R2 uses standard immutable objects and sanitizes failed SDK errors", async t => {
	const dir = await sandbox(t);
	const ledger = path.join(dir, "usage.json");
	const commands: unknown[] = [];
	const store = new R2ResultStore({ ...options, usageFile: ledger }, fakeClient(async command => {
		commands.push(command);
		if (command instanceof GetObjectCommand) return { Body: Readable.from(Buffer.from("data")), ContentLength: 4 };
		if (command instanceof DeleteObjectCommand) return {};
		throw new Error(`https://secret-token:private@cloudflare.test ${options.secretAccessKey}`);
	}));
	await assert.rejects(store.put("jobs/1/out.tar", Buffer.from("data")), error => {
		assert.ok(error instanceof StorageError); assert.equal(error.status, 502);
		assert.equal(error.message, "R2 result upload failed."); assert.equal(error.cause, undefined); return true;
	});
	const put = commands[0] as PutObjectCommand;
	assert.ok(put instanceof PutObjectCommand);
	assert.equal(put.input.StorageClass, "STANDARD");
	assert.equal(put.input.IfNoneMatch, "*");
	assert.equal(put.input.ContentType, "application/x-tar");
	assert.equal((await store.get("jobs/1/out.tar")).size, 4);
	await store.delete("jobs/1/out.tar");
	const usage = JSON.parse(await readFile(ledger, "utf8"));
	assert.equal(usage.uploadedBytes, 4);
	assert.equal(usage.months[new Date().toISOString().slice(0, 7)].writes, 1);
	assert.equal((await stat(ledger)).mode & 0o777, 0o600);
});

test("R2 byte and monthly operation budgets persist across restarts and count failures", async t => {
	const dir = await sandbox(t);
	const file = path.join(dir, "usage.json");
	let requests = 0;
	const client = fakeClient(async () => { requests++; throw new Error("private SDK detail"); });
	const budget = () => new R2Budget(file, { writes: 2, reads: 1, uploadedBytes: 5 });
	const make = () => new R2ResultStore(options, client, budget());
	await assert.rejects(make().put("a", Buffer.from("123")), { status: 502 });
	await assert.rejects(make().put("b", Buffer.from("123")), /budget reached/);
	await assert.rejects(make().put("b", Buffer.from("12")), { status: 502 });
	await assert.rejects(make().put("c", Buffer.from("1")), /budget reached/);
	await assert.rejects(make().get("a"), { status: 502 });
	await assert.rejects(make().get("a"), /budget reached/);
	assert.equal(requests, 3);
	await assert.rejects(make().delete("a"), { status: 502 }); // cleanup remains possible
	assert.equal(requests, 4);
});

test("accounting fails closed on malformed data and concurrent-process lock", async t => {
	const dir = await sandbox(t);
	const file = path.join(dir, "usage.json");
	const budget = new R2Budget(file);
	await writeFile(file, "not-json");
	await assert.rejects(budget.reserve("reads"), /unreadable/);
	await writeFile(file, JSON.stringify({ version: 1, uploadedBytes: 0, months: { "2026-10": { reads: -1, writes: 0 } } }));
	await assert.rejects(budget.reserve("reads"), /invalid/);
	await mkdir(`${file}.lock`);
	await assert.rejects(budget.reserve("writes", 1), /locked/);
});

test("concurrent requests cannot oversubscribe the local R2 budget", async t => {
	const file = path.join(await sandbox(t), "usage.json");
	const budget = new R2Budget(file, { writes: 1 });
	const requests = await Promise.allSettled([budget.reserve("writes", 1), budget.reserve("writes", 1)]);
	assert.equal(requests.filter(r => r.status === "fulfilled").length, 1);
	assert.equal(JSON.parse(await readFile(file, "utf8")).uploadedBytes, 1);
});

test("monthly request counters reset independently while uploaded byte reservations never reset", async t => {
	const file = path.join(await sandbox(t), "usage.json");
	let now = new Date("2026-10-31T00:00:00Z");
	const budget = new R2Budget(file, { writes: 1, uploadedBytes: 2 }, () => now);
	await budget.reserve("writes", 1);
	await assert.rejects(budget.reserve("writes", 1), /budget reached/);
	now = new Date("2026-11-01T00:00:00Z");
	await budget.reserve("writes", 1);
	now = new Date("2026-12-01T00:00:00Z");
	await assert.rejects(budget.reserve("writes", 1), /budget reached/);
});
