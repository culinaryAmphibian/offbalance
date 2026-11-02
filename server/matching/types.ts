export type Awaitable<T> = T | Promise<T>;

export type GpuVendor = 'nvidia' | 'amd';
/** 'none': no GPU needed; 'any': one GPU of either vendor. */
export type GpuRequirement = 'none' | 'any' | GpuVendor;

/** Capacity the job's container gets: the agent enforces vCPUs and memory as Docker limits. */
export interface HardwareRequirements {
  minVcpus?: number;     // logical CPUs (threads)
  minMemoryGb?: number;  // GiB
  gpu?: GpuRequirement;
  minGpuVramGb?: number; // GiB, only with a GPU
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

/** A GPU the provider's benchmark container could use; others aren't offered for jobs. */
export interface MachineGpu {
  vendor: GpuVendor;
  vramGb: number;
}

/** What the matcher checks against HardwareRequirements, from the provider's benchmark. */
export interface MachineSpecs {
  vcpus: number;
  memoryGb: number;
  gpus: MachineGpu[];
}

/** Durable metadata may be incomplete until benchmarks and pricing are reported. */
export interface ProviderRecord {
  wallet: string;
  id?: string;
  accountId?: string;
  registered?: boolean;
  pricePerHour?: string;
  machine?: Partial<MachineSpecs> | null;
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
  machine: MachineSpecs;
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
