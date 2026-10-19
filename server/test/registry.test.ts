// Image reference parsing and registry auth challenges. No network.
// (End-to-end builds: see "Builds" in the README.)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatRef, parseChallenge, parseImageRef } from "../services/registry.ts";

const D = "sha256:" + "a".repeat(64);

describe("parseImageRef", () => {
	const cases: [string, string][] = [
		["alpine", "docker.io/library/alpine:latest"],
		["alpine:3.20", "docker.io/library/alpine:3.20"],
		["library/alpine", "docker.io/library/alpine:latest"],
		["user/app:v1", "docker.io/user/app:v1"],
		["docker.io/alpine", "docker.io/library/alpine:latest"],
		["index.docker.io/user/app", "docker.io/user/app:latest"],
		["ghcr.io/org/team/app:1.0", "ghcr.io/org/team/app:1.0"],
		["localhost:5001/offbalance/jobs:build-1", "localhost:5001/offbalance/jobs:build-1"],
		["localhost/app", "localhost/app:latest"],
		[`alpine@${D}`, `docker.io/library/alpine@${D}`],
		[`alpine:3.20@${D}`, `docker.io/library/alpine@${D}`], // digest wins
	];
	for (const [input, expected] of cases) {
		test(input, () => assert.equal(formatRef(parseImageRef(input)), expected));
	}

	test("rejects malformed references", () => {
		for (const bad of ["", "Alpine", "a b", "alpine@sha256:short", "alpine:", "alpine:-x", "ghcr.io/"]) {
			assert.throws(() => parseImageRef(bad), undefined, JSON.stringify(bad));
		}
	});
});

describe("parseChallenge", () => {
	test("bearer", () => {
		const c = parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"');
		assert.equal(c.scheme, "bearer");
		assert.deepEqual(c.params, {
			realm: "https://auth.docker.io/token",
			service: "registry.docker.io",
			scope: "repository:library/alpine:pull",
		});
	});

	test("basic", () => {
		assert.equal(parseChallenge('Basic realm="Registry Realm"').scheme, "basic");
	});
});
