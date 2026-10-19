// Job lifecycle, as tracked off-chain. Node's type stripping doesn't support
// TS enums, so this is a const object plus a union type.
export const JobStatus = {
	PENDING: "PENDING",
	COMMIT_PHASE: "COMMIT_PHASE",
	REVEAL_PHASE: "REVEAL_PHASE",
	CONSENSUS_VERIFICATION: "CONSENSUS_VERIFICATION",
	AWAITING_DELIVERY: "AWAITING_DELIVERY",
	DELIVERY_RECEIPT_VALIDATION: "DELIVERY_RECEIPT_VALIDATION",
	PAYOUT: "PAYOUT",
	CANCELED: "CANCELED",
	NO_QUORUM: "NO_QUORUM",
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JOB_STATUSES = Object.values(JobStatus);

// the job is over; its providers are free again
export const TERMINAL_STATUSES: JobStatus[] = [JobStatus.PAYOUT, JobStatus.CANCELED, JobStatus.NO_QUORUM];

// providers are working on it (one job per provider at a time)
export const ACTIVE_STATUSES: JobStatus[] = JOB_STATUSES.filter(
	(s) => s !== JobStatus.PENDING && !TERMINAL_STATUSES.includes(s),
);

// Contract event -> the status it moves the job to.
export const STATUS_FOR_EVENT: Record<string, JobStatus> = {
	COMMIT_PHASE_START: JobStatus.COMMIT_PHASE,
	REVEAL_PHASE_START: JobStatus.REVEAL_PHASE,
	CONSENSUS_VERIFICATION_START: JobStatus.CONSENSUS_VERIFICATION,
	DELIVERY_PHASE_START: JobStatus.AWAITING_DELIVERY,
	DELIVERED: JobStatus.PAYOUT,
	CANCELED: JobStatus.CANCELED,
	NO_QUORUM: JobStatus.NO_QUORUM,
};
