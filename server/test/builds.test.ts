// Server-side image builds and image pinning, against MongoDB, a fake OCI registry and a
// fake `docker` CLI on PATH (it records its arguments and stdin and can be told to fail):
//   - Builder: build -> login -> push -> pin by digest, failures, one build at a time, restarts
//   - POST /builds, GET /builds, GET /builds/:id, POST /images/resolve
//   - POST /jobs with `image` (pinned by the server) or `buildId`
//
// Skipped without MONGODB_URI. The fake docker CLI is a shell script, so this needs a POSIX shell.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { fakeRegistry } from "./helpers/registry.ts";

const uri = process.env.MONGODB_URI;
const reg = await fakeRegistry();
const work = mkdtempSync(path.join(tmpdir(), "offbalance-builds-test-"));
const dockerLog = path.join(work, "docker.log");

// The fake CLI: one line per call in docker.log; `build` keeps its stdin (the context) and
// `login` its password; FAKE_DOCKER_FAIL=build|login|push makes that step exit 1. Every call
// reads all of its stdin first: a process that exits without reading it crashes the server
// (see the EPIPE test at the end).
writeFileSync(path.join(work, "docker"), `#!/bin/sh
shift 2 # --config <dir>
echo "$*" >> "${dockerLog}"
case "$1" in
  build) cat > "${work}/context.received"; echo "Step 1/1 : FROM alpine"
         [ "$FAKE_DOCKER_FAIL" = build ] && { echo "boom: missing base image" >&2; exit 1; } ;;
  login) cat > "${work}/password.received"
         [ "$FAKE_DOCKER_FAIL" = login ] && { echo "unauthorized: bad token" >&2; exit 1; } ;;
  push)  cat > /dev/null; [ "$FAKE_DOCKER_FAIL" = push ] && { echo "denied" >&2; exit 1; }; echo "pushed" ;;
  *)     cat > /dev/null ;;
esac
exit 0
`, { mode: 0o755 });

// config reads these at import time
Object.assign(process.env, {
	PATH: `${work}${path.delimiter}${process.env.PATH}`,
	REGISTRY: reg.host, REGISTRY_NAMESPACE: "team", REGISTRY_TOKEN: "push-token",
	DOCKER_CONFIG_DIR: path.join(work, "docker-config"),
});
const { createApp } = await import("../app.ts");
const { connectDB, disconnectDB } = await import("../db.ts");
const { AccountModel, AuthTokenModel, BuildModel, BuildStatus, JobModel, hashToken } = await import("../models/index.ts");
const { Builder } = await import("../services/builder.ts");
const { Matcher } = await import("../services/matcher.ts");

const amd64 = { os: "linux", architecture: "amd64" };
const PINNED = new RegExp(`^${reg.host.replace(/\./g, "\\.")}/team/offbalance-jobs@sha256:[0-9a-f]{64}$`);
const ids: Record<string, mongoose.Types.ObjectId> = {};

const calls = () => existsSync(dockerLog) ? readFileSync(dockerLog, "utf8").trim().split("\n") : [];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Waits until the build is DONE or FAILED and the builder has also removed its local image,
// which happens just after the status is saved. Otherwise that last docker call could land in
// the next test's log.
async function finished(id: unknown) {
	for (let i = 0; i < 400; i++) {
		const build = await BuildModel.findById(id).orFail();
		if ((build.status === BuildStatus.DONE || build.status === BuildStatus.FAILED) && calls().includes(`image rm ${build.tag}`)) {
			return build;
		}
		await sleep(25);
	}
	throw new Error(`build ${id} never finished`);
}

describe("server-side builds and image pinning", { skip: !uri && "set MONGODB_URI to run" }, () => {
	let server: Server, disabledServer: Server;
	let base = "", disabledBase = "";

	const listen = async (builder: InstanceType<typeof Builder>) => {
		const s = createApp({ chain: null, matcher: new Matcher(null), builder }, { log: false }).listen(0, "127.0.0.1");
		await new Promise(resolve => s.once("listening", resolve));
		return { s, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
	};
	const call = async (method: string, url: string, { as = "buyer", body, type, at = base }: { as?: string | null; body?: unknown; type?: string; at?: string } = {}) => {
		const res = await fetch(at + url, {
			method,
			headers: {
				...(as ? { Authorization: `Bearer test-${as}` } : {}),
				...(body !== undefined ? { "Content-Type": type ?? "application/json" } : {}),
			},
			body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-builds-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		for (const [i, user] of ["buyer", "other"].entries()) {
			const wallet = `0x${String(i + 1).padStart(40, "0")}`;
			const account = await AccountModel.create({ walletIds: [wallet] });
			ids[user] = account._id;
			await AuthTokenModel.create({ tokenHash: hashToken(`test-${user}`), account: account._id, wallet });
		}
		({ s: server, url: base } = await listen(new Builder()));
		({ s: disabledServer, url: disabledBase } = await listen({ enabled: false } as InstanceType<typeof Builder>));
	});
	beforeEach(() => {
		writeFileSync(dockerLog, "");
		delete process.env.FAKE_DOCKER_FAIL;
		reg.images.clear();
		reg.fallback = { platform: amd64 };
	});
	after(async () => {
		await Promise.all([server, disabledServer].filter(Boolean).map(s => new Promise(resolve => s.close(resolve))));
		await reg.close();
		if (mongoose.connection.readyState === 1) {
			await mongoose.connection.dropDatabase();
			await disconnectDB();
		}
	});

	describe("Builder", () => {
		test("builds the Dockerfile, logs in once, pushes, and pins the pushed image by digest", async () => {
			const builder = new Builder();
			const dockerfile = "FROM alpine\nRUN echo hi\n";
			const build = await builder.submit(ids.buyer, "dockerfile", Buffer.from(dockerfile));
			assert.equal(build.status, BuildStatus.QUEUED);
			assert.equal(build.tag, `${reg.host}/team/offbalance-jobs:build-${build._id}`);

			const done = await finished(build._id);
			assert.equal(done.status, BuildStatus.DONE, done.error ?? "");
			assert.match(done.image!, PINNED);
			assert.equal(done.image, `${reg.host}/team/offbalance-jobs@${done.digest}`);
			assert.match(done.log, /Step 1\/1 : FROM alpine/);
			assert.ok(done.startedAt && done.finishedAt);

			assert.deepEqual(calls(), [
				`build --platform linux/amd64 --pull --tag ${build.tag} -`,
				`login ${reg.host} --username team --password-stdin`,
				`push ${build.tag}`,
				`image rm ${build.tag}`, // the registry has it; the server's disk doesn't keep it
			]);
			assert.equal(readFileSync(path.join(work, "context.received"), "utf8"), dockerfile);
			assert.equal(readFileSync(path.join(work, "password.received"), "utf8"), "push-token");

			// a second build on the same Builder doesn't log in again
			writeFileSync(dockerLog, "");
			await finished((await builder.submit(ids.buyer, "dockerfile", Buffer.from(dockerfile)))._id);
			assert.ok(!calls().some(c => c.startsWith("login")));
		});

		test("a failing build is FAILED with docker's output, and nothing is pushed", async () => {
			process.env.FAKE_DOCKER_FAIL = "build";
			const build = await finished((await new Builder().submit(ids.buyer, "dockerfile", Buffer.from("FROM nothing")))._id);
			assert.equal(build.status, BuildStatus.FAILED);
			assert.equal(build.error, "docker build failed (exit 1)");
			assert.match(build.log, /boom: missing base image/);
			assert.equal(build.image, null);
			assert.ok(!calls().some(c => c.startsWith("push")));
		});

		test("a rejected registry login fails the build with docker's reason", async () => {
			process.env.FAKE_DOCKER_FAIL = "login";
			const build = await finished((await new Builder().submit(ids.buyer, "dockerfile", Buffer.from("FROM alpine")))._id);
			assert.equal(build.status, BuildStatus.FAILED);
			assert.equal(build.error, `docker login to ${reg.host} failed: unauthorized: bad token`);
		});

		test("a failed push fails the build", async () => {
			process.env.FAKE_DOCKER_FAIL = "push";
			const build = await finished((await new Builder().submit(ids.buyer, "dockerfile", Buffer.from("FROM alpine")))._id);
			assert.equal(build.status, BuildStatus.FAILED);
			assert.equal(build.error, "docker push failed (exit 1)");
		});

		test("a pushed image the registry can't pin (wrong platform) fails the build", async () => {
			reg.fallback = { platform: { os: "linux", architecture: "arm64" } };
			const build = await finished((await new Builder().submit(ids.buyer, "dockerfile", Buffer.from("FROM alpine")))._id);
			assert.equal(build.status, BuildStatus.FAILED);
			assert.match(build.error!, /providers run linux\/amd64/);
		});

		test("runs one build at a time, in submission order", async () => {
			const builder = new Builder();
			const first = await builder.submit(ids.buyer, "dockerfile", Buffer.from("FROM alpine"));
			const second = await builder.submit(ids.buyer, "dockerfile", Buffer.from("FROM busybox"));
			await finished(first._id);
			await finished(second._id);
			const steps = calls().filter(c => !c.startsWith("login")).map(c => c.split(" ").at(-1) === "-"
				? `build ${c.split(" ").at(-2)}` : c);
			assert.deepEqual(steps, [
				`build ${first.tag}`, `push ${first.tag}`, `image rm ${first.tag}`,
				`build ${second.tag}`, `push ${second.tag}`, `image rm ${second.tag}`,
			]);
		});

		test("after a restart, builds that were in progress are marked FAILED; finished ones stay", async () => {
			const make = (status: string) => BuildModel.create({ owner: ids.other, source: "dockerfile", tag: "t", status });
			const [queued, building, pushing, done, failed] = await Promise.all(
				[BuildStatus.QUEUED, BuildStatus.BUILDING, BuildStatus.PUSHING, BuildStatus.DONE, BuildStatus.FAILED].map(make));
			await new Builder().failInterrupted();
			for (const b of [queued, building, pushing]) {
				const after = await BuildModel.findById(b._id).orFail();
				assert.equal(after.status, BuildStatus.FAILED);
				assert.match(after.error!, /server restarted/);
			}
			assert.equal((await BuildModel.findById(done._id).orFail()).status, BuildStatus.DONE);
			assert.equal((await BuildModel.findById(failed._id).orFail()).error, null);
		});
	});

	describe("POST /builds and GET /builds", () => {
		test("a JSON Dockerfile is queued (202) and can be followed to DONE", async () => {
			const res = await call("POST", "/builds", { body: { dockerfile: "FROM alpine" } });
			assert.equal(res.status, 202);
			assert.equal(res.body.build.source, "dockerfile");
			assert.equal(res.body.build.status, BuildStatus.QUEUED);
			await finished(res.body.build.id);
			const polled = await call("GET", `/builds/${res.body.build.id}`);
			assert.equal(polled.status, 200);
			assert.equal(polled.body.build.status, BuildStatus.DONE);
			assert.match(polled.body.build.image, PINNED);
		});

		test("a tar build context is accepted as the raw body", async () => {
			const tar = Buffer.alloc(1024, 0);
			const res = await call("POST", "/builds", { body: tar, type: "application/x-tar" });
			assert.equal(res.status, 202);
			assert.equal(res.body.build.source, "context");
			await finished(res.body.build.id);
			assert.ok(readFileSync(path.join(work, "context.received")).equals(tar), "the exact bytes reach docker build");
		});

		test("rejects a missing, empty or oversized Dockerfile and an empty context", async () => {
			assert.equal((await call("POST", "/builds", { body: {} })).status, 400);
			assert.equal((await call("POST", "/builds", { body: { dockerfile: "   " } })).status, 400);
			assert.equal((await call("POST", "/builds", { body: { dockerfile: "#".repeat(256 * 1024 + 1) } })).status, 413);
			assert.equal((await call("POST", "/builds", { body: Buffer.alloc(0), type: "application/x-tar" })).status, 400);
			assert.equal((await call("POST", "/builds", { as: null, body: { dockerfile: "FROM alpine" } })).status, 401);
		});

		test("answers 503 when the server has no registry configured", async () => {
			const res = await call("POST", "/builds", { body: { dockerfile: "FROM alpine" }, at: disabledBase });
			assert.equal(res.status, 503);
			assert.match(res.body.error, /REGISTRY_NAMESPACE/);
		});

		test("buyers only see their own builds, and the list leaves out logs", async () => {
			const mine = (await call("POST", "/builds", { body: { dockerfile: "FROM alpine" } })).body.build;
			await finished(mine.id);
			const list = await call("GET", "/builds");
			assert.ok(list.body.builds.some((b: { id: string }) => b.id === mine.id));
			assert.ok(list.body.builds.every((b: { log?: string }) => !b.log));
			assert.ok(!(await call("GET", "/builds", { as: "other" })).body.builds.some((b: { id: string }) => b.id === mine.id));
			assert.equal((await call("GET", `/builds/${mine.id}`, { as: "other" })).status, 404);
			assert.equal((await call("GET", "/builds/not-an-id")).status, 404);
		});
	});

	describe("POST /images/resolve", () => {
		test("pins a tag and reports the providers' platform", async () => {
			reg.images.set("team/app:1.0", { platforms: [{ os: "linux", architecture: "arm64" }, amd64] });
			const res = await call("POST", "/images/resolve", { body: { image: `${reg.host}/team/app:1.0` } });
			assert.equal(res.status, 200);
			assert.match(res.body.image, /@sha256:[0-9a-f]{64}$/);
			assert.equal(res.body.platform, "linux/amd64");
		});

		test("rejects a missing image, an unknown image and a malformed reference", async () => {
			reg.fallback = null;
			assert.equal((await call("POST", "/images/resolve", { body: {} })).status, 400);
			const missing = await call("POST", "/images/resolve", { body: { image: `${reg.host}/team/nothing:1` } });
			assert.equal(missing.status, 400);
			assert.match(missing.body.error, /not found, or not public/);
			assert.equal((await call("POST", "/images/resolve", { body: { image: "Bad Ref" } })).status, 400);
		});
	});

	describe("POST /jobs with an image or a build", () => {
		const job = (image: Record<string, unknown>) => ({
			command: ["sh", "-c", "echo hi > /output/out.txt"], maxPrice: "1",
			minNodesToRunOn: 2, minNodesToAgree: 2, timeWindow: 60, ...image,
		});

		test("an image reference is pinned by the server before the job is saved", async () => {
			reg.images.set("team/app:1.0", { platform: amd64 });
			const res = await call("POST", "/jobs", { body: job({ image: `${reg.host}/team/app:1.0` }) });
			assert.equal(res.status, 201, JSON.stringify(res.body));
			const saved = await JobModel.findOne({ onChainJobId: res.body.job.id }).orFail();
			assert.match(saved.dockerImageDigest, new RegExp(`^${reg.host.replace(/\./g, "\\.")}/team/app@sha256:[0-9a-f]{64}$`));
		});

		test("an image that can't be pinned saves nothing and uses up no job id", async () => {
			reg.fallback = null;
			const before = await JobModel.countDocuments();
			const res = await call("POST", "/jobs", { body: job({ image: `${reg.host}/team/nothing:1` }) });
			assert.equal(res.status, 400);
			assert.equal(await JobModel.countDocuments(), before);
		});

		test("a finished build of mine becomes the job's image", async () => {
			const build = (await call("POST", "/builds", { body: { dockerfile: "FROM alpine" } })).body.build;
			const done = await finished(build.id);
			const res = await call("POST", "/jobs", { body: job({ buildId: build.id }) });
			assert.equal(res.status, 201, JSON.stringify(res.body));
			assert.equal((await JobModel.findOne({ onChainJobId: res.body.job.id }).orFail()).dockerImageDigest, done.image);
		});

		test("rejects another buyer's build, an unfinished build, and a made-up id", async () => {
			const theirs = await BuildModel.create({ owner: ids.other, source: "dockerfile", tag: "t",
				status: BuildStatus.DONE, image: `${reg.host}/team/offbalance-jobs@sha256:${"b".repeat(64)}` });
			assert.equal((await call("POST", "/jobs", { body: job({ buildId: String(theirs._id) }) })).status, 400);
			const queued = await BuildModel.create({ owner: ids.buyer, source: "dockerfile", tag: "t", status: BuildStatus.BUILDING });
			const res = await call("POST", "/jobs", { body: job({ buildId: String(queued._id) }) });
			assert.equal(res.status, 409);
			assert.match(res.body.error, /BUILDING/);
			assert.equal((await call("POST", "/jobs", { body: job({ buildId: "nope" }) })).status, 400);
		});

		test("exactly one of image, buildId and dockerImageDigest", async () => {
			const both = job({ image: "alpine", dockerImageDigest: `docker.io/library/alpine@sha256:${"a".repeat(64)}` });
			assert.equal((await call("POST", "/jobs", { body: both })).status, 400);
			assert.equal((await call("POST", "/jobs", { body: job({}) })).status, 400);
		});
	});

	// docker() writes each call's stdin (the registry password for `login`, nothing for `push` and
	// `image rm`) with child.stdin.end(), and child.stdin has no error listener. If docker exits
	// before that write lands (the daemon is down, the image is already gone, ...), the write fails
	// with EPIPE as an uncaught exception, which takes the whole server down. It runs in its own
	// process so the crash can't hit this test runner.
	test("a docker call that exits before reading its input fails instead of crashing the server",
		{ todo: "services/builder.ts docker(): add child.stdin.on('error', ...) so EPIPE is reported through the exit code" },
		() => {
			const bin = mkdtempSync(path.join(tmpdir(), "offbalance-epipe-"));
			writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			const builder = JSON.stringify(path.join(import.meta.dirname, "..", "services", "builder.ts"));
			const script = `
				const { docker } = await import(${builder});
				const result = await docker(["image", "rm", "gone"], { deadline: Date.now() + 10_000 });
				console.log(JSON.stringify(result));`;
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
				env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: "utf8", timeout: 20_000,
			});
			assert.doesNotMatch(child.stderr, /EPIPE/, "the EPIPE escaped as an uncaught exception");
			assert.equal(child.status, 0, child.stderr);
			assert.equal(JSON.parse(child.stdout.trim()).code, 1, "the failure is reported as docker's exit code");
		});
});
