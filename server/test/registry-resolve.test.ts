// RegistryClient.resolve against a fake OCI registry: pinning tags to a digest for the
// providers' platform, the registry auth handshakes, and how failures are reported.
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fakeRegistry } from "./helpers/registry.ts";

const reg = await fakeRegistry();
// the server's own registry credentials; config reads them at import time
process.env.REGISTRY = reg.host;
process.env.REGISTRY_USERNAME = "builder";
process.env.REGISTRY_TOKEN = "secret";
const { RegistryClient, RegistryError } = await import("../services/registry.ts");

const amd64 = { os: "linux", architecture: "amd64" };
const arm64 = { os: "linux", architecture: "arm64" };
const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

async function rejectsWith(promise: Promise<unknown>, status: number, message: RegExp) {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof RegistryError, String(error));
		assert.equal(error.status, status);
		assert.match(error.message, message);
		return true;
	});
}

describe("RegistryClient.resolve", () => {
	beforeEach(() => {
		reg.images.clear();
		reg.failWith.clear();
		reg.requests.length = 0;
		reg.tokenRequests.length = 0;
		reg.auth.mode = "none";
	});
	after(() => reg.close());

	test("pins a multi-platform tag to the linux/amd64 manifest's digest", async () => {
		reg.images.set("team/app:1.0", { platforms: [arm64, amd64] });
		const { image, digest } = await new RegistryClient().resolve(`${reg.host}/team/app:1.0`);
		assert.match(image, DIGEST_RE);
		assert.equal(image, `${reg.host}/team/app@${digest}`);
		// the digest is the amd64 manifest's, not the index's: it's what the second request fetched
		const manifestRequests = reg.requests.filter(r => r.path.includes("/manifests/")).map(r => r.path);
		assert.deepEqual(manifestRequests, [`/v2/team/app/manifests/1.0`, `/v2/team/app/manifests/${digest}`]);
	});

	test("follows the platform it's asked for", async () => {
		reg.images.set("team/app:1.0", { platforms: [arm64, amd64] });
		const client = new RegistryClient();
		const forAmd = await client.resolve(`${reg.host}/team/app:1.0`, "linux/amd64");
		const forArm = await client.resolve(`${reg.host}/team/app:1.0`, "linux/arm64");
		assert.notEqual(forAmd.digest, forArm.digest);
	});

	test("checks a single-platform image's config and rejects another architecture", async () => {
		reg.images.set("team/amd:latest", { platform: amd64 });
		reg.images.set("team/arm:latest", { platform: arm64 });
		const client = new RegistryClient();
		assert.match((await client.resolve(`${reg.host}/team/amd`)).image, DIGEST_RE);
		await rejectsWith(client.resolve(`${reg.host}/team/arm`), 400, /is linux\/arm64, providers run linux\/amd64/);
	});

	test("rejects an index without the providers' platform", async () => {
		reg.images.set("team/app:arm-only", { platforms: [arm64] });
		await rejectsWith(new RegistryClient().resolve(`${reg.host}/team/app:arm-only`), 400, /has no linux\/amd64 image/);
	});

	test("an image pinned by digest resolves to the same digest", async () => {
		reg.images.set("team/amd:latest", { platform: amd64 });
		const client = new RegistryClient();
		const { image, digest } = await client.resolve(`${reg.host}/team/amd`);
		assert.deepEqual(await client.resolve(image), { image, digest });
	});

	test("a registry that returns no digest header for a tag is an error, not an unpinned image", async () => {
		reg.images.set("team/amd:latest", { platform: amd64, noDigestHeader: true });
		await rejectsWith(new RegistryClient().resolve(`${reg.host}/team/amd`), 502, /didn't return a digest/);
	});

	test("bearer auth: follows the challenge once, then reuses the token", async () => {
		reg.auth.mode = "bearer";
		reg.images.set("team/amd:latest", { platform: amd64 });
		const client = new RegistryClient();
		await client.resolve(`${reg.host}/team/amd`);
		await client.resolve(`${reg.host}/team/amd`);
		assert.equal(reg.tokenRequests.length, 1, "one token request for both resolves");
		const params = new URLSearchParams(reg.tokenRequests[0]);
		assert.equal(params.get("scope"), "repository:team/amd:pull");
		assert.equal(params.get("service"), "fake-registry");
	});

	test("basic auth: sends the server's own credentials to its own registry", async () => {
		reg.auth.mode = "basic";
		reg.auth.basic = "builder:secret";
		reg.images.set("team/amd:latest", { platform: amd64 });
		assert.match((await new RegistryClient().resolve(`${reg.host}/team/amd`)).image, DIGEST_RE);
	});

	test("basic auth with the wrong credentials reads as missing, without saying which", async () => {
		reg.auth.mode = "basic";
		reg.auth.basic = "builder:other-secret";
		reg.images.set("team/amd:latest", { platform: amd64 });
		await rejectsWith(new RegistryClient().resolve(`${reg.host}/team/amd`), 400, /not found, or not public/);
	});

	test("never sends the server's credentials to another registry", async () => {
		const other = await fakeRegistry();
		try {
			other.auth.mode = "basic";
			other.auth.basic = "builder:secret";
			other.images.set("team/amd:latest", { platform: amd64 });
			await rejectsWith(new RegistryClient().resolve(`${other.host}/team/amd`), 401, /needs credentials/);
			assert.ok(other.requests.every(r => !r.authorization), "no Authorization header was sent");
		} finally { await other.close(); }
	});

	test("missing images and registry errors map to 400 and 502", async () => {
		const client = new RegistryClient();
		await rejectsWith(client.resolve(`${reg.host}/team/nothing:1`), 400, /not found, or not public/);
		reg.failWith.set("/v2/team/broken/manifests/1", 500);
		await rejectsWith(client.resolve(`${reg.host}/team/broken:1`), 502, /answered 500/);
		reg.failWith.set("/v2/team/private/manifests/1", 403);
		await rejectsWith(client.resolve(`${reg.host}/team/private:1`), 400, /not found, or not public/);
	});

	test("an unreachable registry is a 502", async () => {
		const port = await new Promise<number>(resolve => {
			const probe = createServer().listen(0, "127.0.0.1", () => {
				const { port } = probe.address() as { port: number };
				probe.close(() => resolve(port));
			});
		});
		await rejectsWith(new RegistryClient().resolve(`127.0.0.1:${port}/team/app:1`), 502, /can't reach/);
	});

	test("malformed references fail before any request", async () => {
		await rejectsWith(new RegistryClient().resolve("Not An Image"), 400, /bad image reference/);
		assert.equal(reg.requests.length, 0);
	});
});
