import os from "node:os";
import path from "node:path";

// Everything comes from the environment; defaults match ../dev.env.
export const config = {
	port: Number(process.env.PORT ?? 5000),
	mongodbUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/offbalance",

	rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
	// signs assignProviders / verifyReceipt; must be the account that deployed OffBalance
	serverPrivateKey: process.env.SERVER_PRIVATE_KEY as `0x${string}` | undefined,
	deploymentFile: process.env.DEPLOYMENT_FILE ??
		path.join(import.meta.dirname, "..", "blockchain", "deployments", "localhost.json"),
	// "real" (OffBalance) or "mock" (OffBalanceEventMock, driven by client/dev/event_controller.py)
	contract: process.env.CONTRACT === "mock" ? "mock" : "real",
	// CHAIN=off runs without a node: jobs count as submitted as soon as they're
	// created, and matching only updates the database
	chainEnabled: process.env.CHAIN !== "off",
	chainPollMs: Number(process.env.CHAIN_POLL_MS ?? 1000),
	chainConfirmations: process.env.CHAIN_CONFIRMATIONS === undefined ? undefined : Number(process.env.CHAIN_CONFIRMATIONS),
	chainStartBlock: Number(process.env.CHAIN_START_BLOCK ?? 0),

	// Where buyers' Dockerfiles are pushed after the server builds them. Any OCI
	// registry works: docker.io, ghcr.io, registry.gitlab.com, or a local
	// `registry:2` (localhost:5001). Builds are off until REGISTRY_NAMESPACE is set.
	// The repository must be public (or providers given pull access), since
	// providers pull the image themselves.
	registry: {
		host: process.env.REGISTRY ?? "docker.io",
		namespace: process.env.REGISTRY_NAMESPACE, // Docker Hub user/org, GitHub user/org, ...
		repository: process.env.REGISTRY_REPOSITORY ?? "offbalance-jobs",
		username: process.env.REGISTRY_USERNAME,
		token: process.env.REGISTRY_TOKEN, // access token / API key with push rights
	},
	// every provider must run the same bytes, so images are pinned for one platform
	platform: process.env.IMAGE_PLATFORM ?? "linux/amd64",
	build: {
		timeoutS: Number(process.env.BUILD_TIMEOUT_S ?? 15 * 60),
		maxContextMb: Number(process.env.BUILD_MAX_CONTEXT_MB ?? 50),
		// the server's own docker CLI config, so registry credentials don't touch ~/.docker
		dockerConfigDir: process.env.DOCKER_CONFIG_DIR ??
			path.join(os.homedir(), ".offbalance", "server-docker-config"),
	},
} as const;
