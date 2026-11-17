// A fake OCI registry (the /v2 distribution API) on 127.0.0.1, so registry and build tests
// need no network. The registry client talks plain HTTP to 127.0.0.1:<port>.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Platform = { os: string; architecture: string };
// `platforms`: a multi-platform index with one manifest per platform; `platform`: a single manifest
export type FakeImage = { platforms?: Platform[]; platform?: Platform; noDigestHeader?: boolean };

const digestOf = (body: string) => "sha256:" + createHash("sha256").update(body).digest("hex");

export type FakeRegistry = {
	host: string; // e.g. 127.0.0.1:40123, usable as REGISTRY and in image references
	images: Map<string, FakeImage>; // "repo:tag" -> image
	fallback: FakeImage | null; // served for any other tag, e.g. whatever a build just pushed
	auth: { mode: "none" | "bearer" | "basic"; basic?: string }; // basic: expected "user:password"
	failWith: Map<string, number>; // request path -> status to answer instead
	requests: { path: string; authorization?: string }[];
	tokenRequests: string[];
	close(): Promise<void>;
};

export async function fakeRegistry(): Promise<FakeRegistry> {
	const blobs = new Map<string, string>(); // digest -> body (manifests and configs)
	const registry: Omit<FakeRegistry, "host" | "close"> = {
		images: new Map(), fallback: null, auth: { mode: "none" }, failWith: new Map(), requests: [], tokenRequests: [],
	};
	const store = (body: unknown) => {
		const text = JSON.stringify(body);
		const digest = digestOf(text);
		blobs.set(digest, text);
		return digest;
	};
	const singleManifest = (platform: Platform) =>
		store({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: store(platform) } });

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url!, "http://registry");
		registry.requests.push({ path: url.pathname, authorization: req.headers.authorization });
		const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
		};

		if (url.pathname === "/token") {
			registry.tokenRequests.push(url.search);
			return send(200, { token: "fake-token" });
		}
		const failure = registry.failWith.get(url.pathname);
		if (failure) return send(failure, { errors: [{ code: "FAKE" }] });

		const { mode, basic } = registry.auth;
		const auth = req.headers.authorization;
		if (mode === "bearer" && auth !== "Bearer fake-token") {
			return send(401, undefined, { "WWW-Authenticate": `Bearer realm="http://${address()}/token",service="fake-registry"` });
		}
		if (mode === "basic" && auth !== "Basic " + Buffer.from(basic ?? "").toString("base64")) {
			return send(401, undefined, { "WWW-Authenticate": 'Basic realm="fake"' });
		}

		const match = url.pathname.match(/^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/);
		if (!match) return send(404);
		const [, repository, kind, reference] = match;
		if (reference.startsWith("sha256:")) {
			const body = blobs.get(reference);
			return body ? send(200, body, { "Docker-Content-Digest": reference }) : send(404);
		}
		const image = kind === "manifests" && (registry.images.get(`${repository}:${reference}`) ?? registry.fallback);
		if (!image) return send(404);
		const digest = image.platforms
			? store({
				mediaType: "application/vnd.oci.image.index.v1+json",
				manifests: image.platforms.map(platform => ({ digest: singleManifest(platform), platform })),
			})
			: singleManifest(image.platform!);
		send(200, blobs.get(digest), image.noDigestHeader ? {} : { "Docker-Content-Digest": digest });
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = () => `127.0.0.1:${(server.address() as { port: number }).port}`;

	// the same object the server reads, so tests can change auth, images and failures as they go
	return Object.assign(registry, {
		host: address(),
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	});
}
