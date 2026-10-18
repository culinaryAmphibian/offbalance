// Contract tests: the routes the provider client calls (client/server/ServerManager.py,
// client/main.py), checked against whichever server you point them at. The real
// server must pass the same tests as the dev mock, so the client works with both.
//
//   npm run test:dev    # against dev-server.ts (validates the tests themselves)
//   npm run test:real   # against server.ts
//   SERVER_URL=http://localhost:3000 node --test "test/**/*.test.ts"   # against an already-running server
//
// A spawned server must listen on process.env.PORT.
//
// Knobs for the real server:
//   TEST_API_KEY  a valid API key (default "dev"; the mock accepts any token)
//   TEST_JOB_ID   a job that exists (default 1)
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER_DIR = path.join(import.meta.dirname, "..");
const API_KEY = process.env.TEST_API_KEY ?? "dev";
const JOB_ID = Number(process.env.TEST_JOB_ID ?? 1);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

let baseUrl = process.env.SERVER_URL?.replace(/\/$/, "") ?? "";
let child: ChildProcess | undefined;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

// a fake deployment file so the dev server can answer /contract_address without a chain
function fakeDeployment(): string {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "offbalance-")), "localhost.json");
	writeFileSync(file, JSON.stringify({
		chainId: 31337,
		address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
		abi: [],
		eventMock: { address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", abi: [] },
	}));
	return file;
}

async function startServer(file: string): Promise<string> {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	child = spawn(process.execPath, [file], {
		cwd: SERVER_DIR,
		env: { ...process.env, PORT: String(port), DEPLOYMENT_FILE: fakeDeployment() },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr!.on("data", (d) => (stderr += d));

	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`${file} exited with code ${child.exitCode} before listening on PORT=${port}\n${stderr}`);
		}
		try {
			await fetch(url);
			return url; // any HTTP response means it's listening
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`${file} never listened on PORT=${port} (it must use process.env.PORT)\n${stderr}`);
}

const auth = { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" };

// what python requests sends for data={...}: form-encoded, None values dropped
function form(fields: Record<string, number | null>): URLSearchParams {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(fields)) if (v !== null) body.set(k, String(v));
	return body;
}

before(async () => {
	if (!baseUrl) baseUrl = await startServer(process.env.SERVER_FILE ?? "dev-server.ts");
});

after(() => {
	child?.kill();
});

describe("GET /contract_address", () => {
	test("rejects requests without a bearer token", async () => {
		const res = await fetch(`${baseUrl}/contract_address`);
		assert.equal(res.status, 401);
	});

	test("returns the contract address as { address }", async () => {
		const res = await fetch(`${baseUrl}/contract_address`, { headers: auth });
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.match(body.address, ADDRESS_RE);
	});
});

describe("POST /scores", () => {
	test("rejects requests without a bearer token", async () => {
		const res = await fetch(`${baseUrl}/scores`, { method: "POST", body: form({ cpu: 1, gpu: null, mem: 1 }) });
		assert.equal(res.status, 401);
	});

	test("accepts form-encoded cpu, gpu and mem", async () => {
		const res = await fetch(`${baseUrl}/scores`, { method: "POST", headers: auth, body: form({ cpu: 123456.5, gpu: 42, mem: 9876.25 }) });
		assert.ok(res.ok, `expected 2xx, got ${res.status}`);
	});

	test("accepts a missing gpu (the client sends None when there's no GPU backend)", async () => {
		const res = await fetch(`${baseUrl}/scores`, { method: "POST", headers: auth, body: form({ cpu: 123456.5, gpu: null, mem: 9876.25 }) });
		assert.ok(res.ok, `expected 2xx, got ${res.status}`);
	});

	test("rejects scores without cpu or mem", async () => {
		for (const fields of [{ mem: 1 }, { cpu: 1 }]) {
			const res = await fetch(`${baseUrl}/scores`, { method: "POST", headers: auth, body: form(fields) });
			assert.equal(res.status, 400, `body ${JSON.stringify(fields)}`);
		}
	});
});

describe("GET /jobManifest/:jobId", () => {
	test("rejects requests without a bearer token", async () => {
		const res = await fetch(`${baseUrl}/jobManifest/${JOB_ID}`);
		assert.equal(res.status, 401);
	});

	test("returns { manifest } with the fields RunManager uses", async () => {
		const res = await fetch(`${baseUrl}/jobManifest/${JOB_ID}`, { headers: auth });
		assert.equal(res.status, 200);
		const { manifest } = await res.json();
		assert.ok(manifest, "response has no 'manifest' field");

		assert.equal(manifest.jobId, JOB_ID);
		assert.equal(typeof manifest.image, "string");
		assert.ok(manifest.image.length > 0, "image is empty");
		assert.ok(Array.isArray(manifest.command) && manifest.command.every((c: unknown) => typeof c === "string"),
			"command must be a list of strings (docker exec form)");
		assert.ok(manifest.env === null || (typeof manifest.env === "object" && !Array.isArray(manifest.env)),
			"env must be an object or null");
		for (const v of Object.values(manifest.env ?? {})) assert.equal(typeof v, "string", "env values must be strings");
		assert.ok(manifest.input_url === null || typeof manifest.input_url === "string", "input_url must be a string or null");
		for (const key of ["timeout_s", "cpu_limit", "mem_limit_mb"]) {
			assert.ok(typeof manifest[key] === "number" && manifest[key] > 0, `${key} must be a positive number`);
		}
	});

	test("rejects a jobId that isn't a non-negative integer", async () => {
		for (const bad of ["abc", "-1", "1.5"]) {
			const res = await fetch(`${baseUrl}/jobManifest/${bad}`, { headers: auth });
			assert.equal(res.status, 400, `jobId ${bad}`);
		}
	});
});
