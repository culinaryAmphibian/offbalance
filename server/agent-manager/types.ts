/** Persisted job IDs are strings; numeric IDs remain supported by provider clients. */
export type JobId = string | number;
export type Awaitable<T> = T | Promise<T>;
export interface Assignment {
  id: JobId;
  dockerImage?: unknown;
  requirements?: unknown;
  window?: unknown;
  deadlineAt?: unknown;
}
export interface AssignmentRepository {
  getAssignedJob(jobId: JobId, providerId: string): Awaitable<Assignment | null | undefined>;
}
export interface OutputRequestOptions { signal?: AbortSignal; timeoutMs?: number; providerId?: string }
export interface ProviderOutput {
  bytes: Uint8Array;
  sha256: string;
  filename: string;
  providerId: string;
  wallet: string;
}
export interface ProviderTransport {
  requestOutput(jobId: JobId, wallet: string, options?: OutputRequestOptions): Promise<ProviderOutput>;
}
export interface OutputMetadata { jobId: JobId; providerId: string; hash: string; filename: string }
export interface ObjectStorage<Reference = string> {
  put(bytes: Uint8Array, metadata: OutputMetadata): Awaitable<Reference>;
  get(reference: Reference, options?: { signal?: AbortSignal }): Awaitable<Uint8Array>;
}
export interface AgentManagerOptions<Reference = string> {
  providerTransport: ProviderTransport;
  objectStorage: ObjectStorage<Reference>;
  repository: AssignmentRepository;
  maxOutputBytes?: number;
}
export interface CollectOutputOptions {
  jobId: JobId;
  providerId: string;
  wallet: string;
  expectedHash: unknown;
  signal?: AbortSignal;
}
export interface AnswerOptions { expectedHash?: unknown; signal?: AbortSignal }
