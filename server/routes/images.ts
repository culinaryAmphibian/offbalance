// Images for jobs: resolve an existing image to a pinned digest, or have the
// server build a Dockerfile and push it to the registry.
import express, { Router } from "express";
import { isValidObjectId } from "mongoose";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { BuildModel, type Build } from "../models/index.ts";
import { registry } from "../services/registry.ts";
import type { Deps } from "./deps.ts";

const TAR_TYPES = ["application/x-tar", "application/gzip", "application/x-gzip", "application/octet-stream"];
const MAX_DOCKERFILE_BYTES = 256 * 1024;

export function serializeBuild(b: Build & { _id: unknown }) {
	return {
		id: String(b._id),
		status: b.status,
		source: b.source,
		image: b.image, // use as `image` / `dockerImageDigest` in POST /jobs (or pass `buildId`)
		error: b.error,
		log: b.log,
		createdAt: b.createdAt,
		startedAt: b.startedAt,
		finishedAt: b.finishedAt,
	};
}

export function imageRoutes({ builder }: Deps): Router {
	const router = Router();

	// `{ "image": "python:3.12" }` -> `{ "image": "docker.io/library/python@sha256:..." }`
	router.post("/images/resolve", requireAuth, async (req, res) => {
		const image = req.body?.image;
		if (typeof image !== "string") {
			res.status(400).json({ error: "image is required" });
			return;
		}
		res.json({ ...(await registry.resolve(image)), platform: config.platform });
	});

	// Either JSON `{ "dockerfile": "FROM ..." }` (no build context, so no COPY/ADD
	// of local files), or a tar / tar.gz body with a Dockerfile at its root.
	// Answers 202; poll GET /builds/:buildId until DONE or FAILED.
	router.post(
		"/builds",
		requireAuth,
		express.raw({ type: TAR_TYPES, limit: `${config.build.maxContextMb}mb` }),
		async (req, res) => {
			if (!builder.enabled) {
				res.status(503).json({ error: "builds are off: the server has no registry configured (REGISTRY_NAMESPACE)" });
				return;
			}
			let source: "dockerfile" | "context";
			let context: Buffer;
			if (Buffer.isBuffer(req.body)) {
				source = "context";
				context = req.body;
			} else if (typeof req.body?.dockerfile === "string" && req.body.dockerfile.trim()) {
				source = "dockerfile";
				context = Buffer.from(req.body.dockerfile);
			} else {
				res.status(400).json({ error: `send JSON { dockerfile } or a tar build context (${TAR_TYPES.join(", ")})` });
				return;
			}
			if (source === "dockerfile" && context.length > MAX_DOCKERFILE_BYTES) {
				res.status(413).json({ error: "Dockerfile too large" });
				return;
			}
			if (context.length === 0) {
				res.status(400).json({ error: "empty build context" });
				return;
			}
			const build = await builder.submit(res.locals.account._id, source, context);
			res.status(202).json({ build: serializeBuild(build) });
		},
	);

	router.get("/builds", requireAuth, async (_req, res) => {
		const builds = await BuildModel.find({ owner: res.locals.account._id }, "-log").sort({ createdAt: -1 }).limit(50);
		res.json({ builds: builds.map(serializeBuild) });
	});

	router.get("/builds/:buildId", requireAuth, async (req, res) => {
		const build = isValidObjectId(req.params.buildId) && await BuildModel.findById(req.params.buildId);
		if (!build || !build.owner.equals(res.locals.account._id)) {
			res.status(404).json({ error: "no such build" });
			return;
		}
		res.json({ build: serializeBuild(build) });
	});

	return router;
}
