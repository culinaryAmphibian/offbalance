import { normalizeJob } from './jobs.js';

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function createApi({ baseUrl = '/api', fetcher = globalThis.fetch } = {}) {
  let token = null;
  const root = baseUrl.replace(/\/$/, '');
  const api = {
    setToken(value) { token = value; },
    onUnauthorized: null,
    nonce: (wallet, chainId) => request(`/auth/nonce?${new URLSearchParams({ wallet, chainId, ...(globalThis.location ? { origin: globalThis.location.origin } : {}) })}`),
    verify: (message, signature) => request('/auth/verify', { method: 'POST', body: { message, signature } }),
    listJobs: async (view, signal) => {
      const data = await request(`/jobs?${new URLSearchParams({ view })}`, { signal });
      return { ...data, jobs: Array.isArray(data.jobs) ? data.jobs.map(normalizeJob) : data.jobs };
    },
    createJob: async (job, key) => {
      const data = await request('/jobs', { method: 'POST', body: job, headers: { 'Idempotency-Key': key } });
      return { ...data, job: normalizeJob(data.job) };
    },
    getJob: async (id, signal) => {
      const data = await request(`/jobs/${encodeURIComponent(id)}`, { signal });
      return { ...data, job: normalizeJob(data.job) };
    },
    getResult: (id, signal) => request(`/jobs/${encodeURIComponent(id)}/result`, { signal, binary: true }),
    getProvider: signal => request('/provider/profile', { signal }),
    getProviderTutorial: signal => request('/provider/tutorial', { signal }),
    saveProviderPricing: pricing => request('/provider/pricing', { method: 'POST', body: pricing }),
  };

  async function request(path, { body, headers, signal, binary = false, ...options } = {}) {
    const requestToken = token;
    let response;
    try {
      response = await fetcher(`${root}${path}`, {
        ...options,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        headers: {
          Accept: binary ? 'application/octet-stream' : 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(error.name === 'TimeoutError' ? 'The server took too long. Try again.' : 'Cannot reach the server. Check your connection and API address.');
    }
    if (response.status === 401 && requestToken && requestToken === token) api.onUnauthorized?.();
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new ApiError(problem?.message || `Request failed (${response.status}).`, response.status);
    }
    if (binary) return response.blob();
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new ApiError('The API did not return JSON. Check VITE_API_BASE_URL.');
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError('The server returned invalid JSON. Try again or check the API response.');
    }
  }
  return api;
}
