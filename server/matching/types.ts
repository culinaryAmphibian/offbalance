export type Awaitable<T> = T | Promise<T>;

export interface HardwareRequirements {
  minCpuScore?: number;
  minGpuScore?: number;
  minMemoryScore?: number;
}

export interface SchedulingJob {
  id: string;
  owner: string;
  k: number;
  window: number;
  maxPrice: string;
  createdAt: string;
  requirements?: HardwareRequirements;
  quorum?: number;
  [key: string]: unknown;
}

export interface MachineScores {
  cpuScore: number;
  gpuScore: number | null;
  memoryScore: number;
}

/** Durable metadata may be incomplete until benchmarks and pricing are reported. */
export interface ProviderRecord {
  wallet: string;
  id?: string;
  accountId?: string;
  registered?: boolean;
  pricePerHour?: string;
  machine?: Partial<MachineScores> | null;
  lastHeartbeat?: number;
  busyJobId?: string | null;
  lastAssignedAt?: number;
  [key: string]: unknown;
}

export interface LiveProvider extends ProviderRecord {
  lastHeartbeat: number;
  busyJobId: string | null;
  lastAssignedAt: number;
}

export interface AvailableProvider extends LiveProvider {
  registered: true;
  accountId: string;
  pricePerHour: string;
  machine: MachineScores;
}

export interface ProviderQuote {
  wallet: string;
  rateWei: string;
  pricePerHour: string;
  costWei: string;
  cost: string;
}

export interface MatchQuote {
  totalWei: string;
  totalPrice: string;
  providers: ProviderQuote[];
}

export interface Match {
  job: SchedulingJob;
  providers: AvailableProvider[];
  quote: MatchQuote;
}

export type MatchCallback = (job: SchedulingJob, providers: AvailableProvider[], quote: MatchQuote) => Awaitable<void>;

export interface MatchRepository {
  getJob(id: string): Awaitable<SchedulingJob | null>;
  listProviders(job: SchedulingJob): Awaitable<ProviderRecord[]>;
}
