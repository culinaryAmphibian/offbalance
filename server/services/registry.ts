// Docker registry client (OCI distribution API): resolves image references to a
// pinned digest for one platform, so every provider runs byte-identical code.
// Works with Docker Hub, GHCR, GitLab, Harbor, ECR (basic auth) and `registry:2`.
import { config } from "../config.ts";

export class RegistryError extends Error {
	status: number; // HTTP status to answer with
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export type ImageRef = { registry: string; repository: string; tag: string | null; digest: string | null };

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// Docker's normalization: `alpine` -> docker.io/library/alpine:latest,
// `ghcr.io/o/r@sha256:..` -> registry ghcr.io, repository o/r.
export function parseImageRef(ref: string): ImageRef {
	let rest = ref.trim();
	if (!rest || /\s/.test(rest)) throw new RegistryError(`bad image reference "${ref}"`);

	let digest: string | null = null;
	const at = rest.indexOf("@");
	if (at !== -1) {
		digest = rest.slice(at + 1);
		rest = rest.slice(0, at);
		if (!DIGEST_RE.test(digest)) throw new RegistryError(`bad digest in "${ref}"`);
	}

	let tag: string | null = null;
	const lastSlash = rest.lastIndexOf("/");
	const colon = rest.lastIndexOf(":");
	if (colon > lastSlash) {
		tag = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}

	const parts = rest.split("/");
	let registry = "docker.io";
	if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) {
		registry = parts.shift()!;
	}
	if (registry === "index.docker.io" || registry === "registry-1.docker.io") registry = "docker.io";
	if (registry === "docker.io" && parts.length === 1) parts.unshift("library");

	const repository = parts.join("/");
	if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repository)) {
		throw new RegistryError(`bad repository name in "${ref}"`);
	}
	if (tag !== null && !/^[\w][\w.-]{0,127}$/.test(tag)) throw new RegistryError(`bad tag in "${ref}"`);
	if (!tag && !digest) tag = "latest";
	return { registry, repository, tag, digest };
}

export function formatRef({ registry, repository, tag, digest }: ImageRef): string {
	return `${registry}/${repository}${digest ? `@${digest}` : `:${tag}`}`;
}

function apiBase(registry: string): string {
	const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
	const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(registry);
	return `${local ? "http" : "https"}://${host}/v2`;
}

// `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="..."`
export function parseChallenge(header: string): { scheme: string; params: Record<string, string> } {
	const [scheme, ...rest] = header.split(" ");
	const params: Record<string, string> = {};
	for (const m of rest.join(" ").matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
	return { scheme: scheme.toLowerCase(), params };
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Platform = { os: string; architecture: string; variant?: string };

function parsePlatform(p: string): Platform {
	const [os, architecture, variant] = p.split("/");
	return { os, architecture, variant };
}

export class RegistryClient {
	private tokens = new Map<string, string>(); // "registry repo" -> bearer token

	// credentials only go to the registry they're for
	private basicAuth(registry: string): string | null {
		const { host, username, token } = config.registry;
		if (!token || parseImageRef(`${host}/x/y`).registry !== registry) return null;
		return "Basic " + Buffer.from(`${username ?? ""}:${token}`).toString("base64");
	}

	private async authorize(registry: string, challenge: string, scope: string): Promise<string> {
		const { scheme, params } = parseChallenge(challenge);
		const basic = this.basicAuth(registry);
		if (scheme === "basic") {
			if (!basic) throw new RegistryError(`${registry} needs credentials`, 401);
			return basic;
		}
		const url = new URL(params.realm);
		if (params.service) url.searchParams.set("service", params.service);
		url.searchParams.set("scope", scope);
		const res = await fetch(url, { headers: basic ? { Authorization: basic } : {} });
		if (!res.ok) throw new RegistryError(`${registry} token request failed: ${res.status}`, res.status === 401 ? 401 : 502);
		const body = await res.json() as { token?: string; access_token?: string };
		return `Bearer ${body.token ?? body.access_token}`;
	}

	// GET with the registry's auth dance: try anonymously (or with a cached
	// token), and on 401 follow the WWW-Authenticate challenge once
	private async get(ref: ImageRef, path: string, accept: string): Promise<Response> {
		const key = `${ref.registry} ${ref.repository}`;
		const url = `${apiBase(ref.registry)}/${ref.repository}/${path}`;
		const send = (auth?: string) =>
			fetch(url, { headers: { Accept: accept, ...(auth ? { Authorization: auth } : {}) } });

		let res: Response;
		try {
			res = await send(this.tokens.get(key));
			if (res.status === 401) {
				const challenge = res.headers.get("www-authenticate");
				if (!challenge) throw new RegistryError(`${ref.registry} refused access`, 401);
				const auth = await this.authorize(ref.registry, challenge, `repository:${ref.repository}:pull`);
				this.tokens.set(key, auth);
				res = await send(auth);
			}
		} catch (e) {
			if (e instanceof RegistryError) throw e;
			throw new RegistryError(`can't reach ${ref.registry}: ${(e as Error).message}`, 502);
		}

		if (res.status === 401 || res.status === 403 || res.status === 404) {
			// registries answer 401 for missing repos too, so they don't leak private names
			throw new RegistryError(`${formatRef(ref)} not found, or not public`, 400);
		}
		if (!res.ok) throw new RegistryError(`${ref.registry} answered ${res.status} for ${formatRef(ref)}`, 502);
		return res;
	}

	// Resolves to `registry/repo@sha256:...` of the single-platform manifest
	// for `platform`, and checks it exists.
	async resolve(image: string, platform = config.platform): Promise<{ image: string; digest: string }> {
		const ref = parseImageRef(image);
		const want = parsePlatform(platform);

		let res = await this.get(ref, `manifests/${ref.digest ?? ref.tag}`, MANIFEST_TYPES);
		let manifest = await res.json() as {
			mediaType?: string;
			manifests?: { digest: string; platform?: Platform }[];
			config?: { digest: string };
		};
		let digest = res.headers.get("docker-content-digest") ?? ref.digest;

		// multi-platform index: pick ours
		if (manifest.manifests) {
			const match = manifest.manifests.find(({ platform: p }) =>
				p?.os === want.os && p.architecture === want.architecture &&
				(!want.variant || p.variant === want.variant));
			if (!match) throw new RegistryError(`${formatRef(ref)} has no ${platform} image`);
			digest = match.digest;
			res = await this.get(ref, `manifests/${digest}`, MANIFEST_TYPES);
			manifest = await res.json();
		}
		if (!digest || !DIGEST_RE.test(digest)) throw new RegistryError(`${ref.registry} didn't return a digest`, 502);

		// single-platform manifest: its config says what it was built for
		if (manifest.config) {
			const cfg = await (await this.get(ref, `blobs/${manifest.config.digest}`, "*/*")).json() as Platform;
			if (cfg.os !== want.os || cfg.architecture !== want.architecture) {
				throw new RegistryError(`${formatRef(ref)} is ${cfg.os}/${cfg.architecture}, providers run ${platform}`);
			}
		}
		return { image: formatRef({ ...ref, tag: null, digest }), digest };
	}
}

export const registry = new RegistryClient();
