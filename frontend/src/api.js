import { normalizeJob } from "./jobs.js";

export class ApiError extends Error {
	constructor(message, status = 0) {
		super(message);
		this.status = status;
	}
}

export function createApi({
	baseUrl = "/api",
	fetcher = globalThis.fetch,
} = {}) {
	let token = null;
	const root = baseUrl.replace(/\/$/, "");
	const api = {
		setToken(value) {
			token = value;
		},
		onUnauthorized: null,
		nonce: (wallet) =>
			request(`/auth/nonce?${new URLSearchParams({ wallet })}`),
		verify: async (wallet, signature) => {
			const data = await request("/auth", {
				method: "POST",
				body: { wallet, signature },
			});
			return { ...data, account: { id: data.accountId, wallet: data.wallet } };
		},
		logout: async (sessionToken = token) => sessionToken
			? request("/auth/logout", { method: "POST", sessionToken })
			: null,
		getConfig: (signal) => request("/config", { signal }),
		listJobs: async (view, signal) => {
			const [data, dashboard] = await Promise.all([
				request(`/jobs?${new URLSearchParams({ role: view })}`, { signal }),
				request("/account/me/dashboard", { signal }),
			]);
			const { jobs: _recentJobs, hardware: _hardware, ...summary } = dashboard[view] ?? {};
			return {
				...data,
				jobs: Array.isArray(data.jobs) ? data.jobs.map(normalizeJob) : data.jobs,
				summary: {
					...summary,
					...(view === "provider" ? { currentStake: dashboard.account?.currentStake } : {}),
				},
			};
		},
		createJob: async (job, key) => {
			const data = await request("/jobs", {
				method: "POST",
				body: job,
				headers: { "Idempotency-Key": key },
			});
			return { ...data, job: normalizeJob(data.job) };
		},
		getJob: async (id, signal) => {
			const data = await request(`/jobs/${encodeURIComponent(id)}`, {
				signal,
			});
			return { ...data, job: normalizeJob(data.job) };
		},
		getResult: (id, signal) =>
			request(`/jobs/${encodeURIComponent(id)}/result`, {
				signal,
			}),
		getProvider: async (signal) => {
			const [data, dashboard] = await Promise.all([
				request("/provider/hardware", { signal }).catch(error => {
					if (error.status === 404) return { hardware: null };
					throw error;
				}),
				request("/account/me/dashboard", { signal }),
			]);
			return { provider: providerProfile(data, dashboard.account?.currentStake) };
		},
		getProviderTutorial: async (signal) => {
			const data = await request("/provider/tutorial", { signal });
			return { tutorial: {
				title: "Client setup",
				steps: typeof data.text === "string" ? data.text.split(/\n+/).map(step => step.replace(/^\s*\d+\.\s*/, "").trim()).filter(Boolean) : [],
				updatedAt: data.updatedAt,
			} };
		},
		saveProviderPricing: async ({ pricePerHour }) => {
			const data = await request("/provider/price", {
				method: "POST", body: { price: pricePerHour },
			});
			return { provider: providerProfile(data) };
		},
	};

	async function request(
		path,
		{ body, headers, signal, sessionToken = token, ...options } = {},
	) {
		const requestToken = sessionToken;
		let response;
		try {
			response = await fetcher(`${root}${path}`, {
				...options,
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(20000)])
					: AbortSignal.timeout(20000),
				headers: {
					Accept: "application/json",
					...(body ? { "Content-Type": "application/json" } : {}),
					...(requestToken
						? { Authorization: `Bearer ${requestToken}` }
						: {}),
					...headers,
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new ApiError(
				error.name === "TimeoutError"
					? "The server took too long. Try again."
					: "Cannot reach the server. Check your connection and API address.",
			);
		}
		if (response.status === 401 && requestToken && requestToken === token)
			api.onUnauthorized?.();
		if (!response.ok) {
			const problem = await response.json().catch(() => null);
			throw new ApiError(
				problem?.error || problem?.message || `Request failed (${response.status}).`,
				response.status,
			);
		}
		if (response.status === 204) return null;
		if (
			!response.headers.get("content-type")?.includes("application/json")
		) {
			throw new ApiError(
				"The API did not return JSON. Check VITE_API_BASE_URL.",
			);
		}
		try {
			return await response.json();
		} catch {
			throw new ApiError(
				"The server returned invalid JSON. Try again or check the API response.",
			);
		}
	}
	return api;
}

function rateText(value) {
	return typeof value === "number" ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }) : String(value);
}

function providerProfile({ hardware, suggestedPrice, online, lastSeen }, currentStake) {
	return {
		registered: Boolean(hardware),
		online: online ?? false,
		lastSeen: lastSeen ?? null,
		currentStake,
		pricePerHour: hardware?.price == null ? null : rateText(hardware.price),
		suggestedPricePerHour: suggestedPrice == null ? null : rateText(suggestedPrice),
		machine: hardware ?? null,
	};
}
