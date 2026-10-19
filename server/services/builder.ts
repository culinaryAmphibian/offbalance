// Builds buyers' Dockerfiles with the server's docker CLI, pushes them to the
// configured registry and pins the result by digest. One build at a time.
//
// The Dockerfile's RUN steps execute on this machine (inside build containers),
// so only run builds on a host you're happy to dedicate to that.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Types } from "mongoose";
import { config } from "../config.ts";
import { BuildModel, BuildStatus } from "../models/index.ts";
import { registry } from "./registry.ts";

const CONTEXT_DIR = path.join(os.tmpdir(), "offbalance-builds");
const LOG_LIMIT = 64 * 1024;

type DockerResult = { code: number | null; output: string };

export class Builder {
	private queue: Promise<void> = Promise.resolve();
	private loggedIn = false;

	get enabled(): boolean {
		return Boolean(config.registry.namespace);
	}

	// `docker.io/<namespace>/offbalance-jobs`, `ghcr.io/<namespace>/offbalance-jobs`, ...
	get repository(): string {
		const { host, namespace, repository } = config.registry;
		return `${host}/${namespace}/${repository}`;
	}

	// Saves the build context and queues the build. `context` is either Dockerfile
	// text or a tar(.gz) with a Dockerfile at its root.
	async submit(owner: Types.ObjectId, source: "dockerfile" | "context", context: Buffer) {
		const build = new BuildModel({ owner, source, tag: "pending" });
		build.tag = `${this.repository}:build-${build._id}`;
		await mkdir(CONTEXT_DIR, { recursive: true });
		await writeFile(this.contextPath(build._id), context);
		await build.save();
		this.queue = this.queue
			.then(() => this.run(build._id))
			.catch((e) => console.error(`Build ${build._id} crashed:`, e));
		return build;
	}

	// builds interrupted by a restart can't resume; their context is gone
	async failInterrupted(): Promise<void> {
		await BuildModel.updateMany(
			{ status: { $in: [BuildStatus.QUEUED, BuildStatus.BUILDING, BuildStatus.PUSHING] } },
			{ status: BuildStatus.FAILED, error: "server restarted during the build; submit it again", finishedAt: new Date() },
		);
	}

	private contextPath(id: Types.ObjectId): string {
		return path.join(CONTEXT_DIR, String(id));
	}

	private async run(id: Types.ObjectId): Promise<void> {
		const build = (await BuildModel.findById(id))!;
		let log = "";
		const append = (chunk: string) => {
			log = (log + chunk).slice(-LOG_LIMIT);
		};
		const deadline = Date.now() + config.build.timeoutS * 1000;
		const step = async (status: BuildStatus) => {
			build.set({ status, log, ...(status === BuildStatus.BUILDING ? { startedAt: new Date() } : {}) });
			await build.save();
		};

		try {
			await step(BuildStatus.BUILDING);
			const built = await docker(
				["build", "--platform", config.platform, "--pull", "--tag", build.tag, "-"],
				{ stdinFile: this.contextPath(id), deadline, onOutput: append },
			);
			if (built.code !== 0) throw new Error(`docker build failed (exit ${built.code})`);

			await step(BuildStatus.PUSHING);
			await this.login(deadline);
			const pushed = await docker(["push", build.tag], { deadline, onOutput: append });
			if (pushed.code !== 0) throw new Error(`docker push failed (exit ${pushed.code})`);

			// pin what providers will actually pull, straight from the registry
			const { image, digest } = await registry.resolve(build.tag);
			build.set({ status: BuildStatus.DONE, image, digest, log, finishedAt: new Date() });
			await build.save();
			console.log(`Build ${id}: ${image}`);
		} catch (e) {
			build.set({ status: BuildStatus.FAILED, error: (e as Error).message, log, finishedAt: new Date() });
			await build.save();
			console.error(`Build ${id} failed: ${(e as Error).message}`);
		} finally {
			await rm(this.contextPath(id), { force: true });
			// the registry has it now; don't fill the server's disk
			await docker(["image", "rm", build.tag], { deadline: Date.now() + 60_000 }).catch(() => {});
		}
	}

	// `docker login` into the server's own docker config, once per process
	private async login(deadline: number): Promise<void> {
		const { host, username, namespace, token } = config.registry;
		if (this.loggedIn || !token) return; // e.g. a local registry:2 needs no login
		const res = await docker(
			["login", host, "--username", username ?? namespace!, "--password-stdin"],
			{ stdinText: token, deadline },
		);
		if (res.code !== 0) throw new Error(`docker login to ${host} failed: ${res.output.trim().split("\n").pop()}`);
		this.loggedIn = true;
	}
}

// Runs the docker CLI against the server's own config dir (credentials stay out of ~/.docker).
export function docker(
	args: string[],
	opts: { stdinFile?: string; stdinText?: string; deadline: number; onOutput?: (s: string) => void },
): Promise<DockerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["--config", config.build.dockerConfigDir, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		const collect = (d: Buffer) => {
			const s = d.toString();
			output = (output + s).slice(-LOG_LIMIT);
			opts.onOutput?.(s);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);

		const timer = setTimeout(() => {
			child.kill();
			opts.onOutput?.("\n[offbalance] build timed out\n");
		}, Math.max(0, opts.deadline - Date.now()));

		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new Error(`can't run docker: ${e.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});

		if (opts.stdinFile) createReadStream(opts.stdinFile).pipe(child.stdin);
		else child.stdin.end(opts.stdinText ?? "");
	});
}
