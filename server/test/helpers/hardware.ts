// Hardware profiles for tests: the body the provider client POSTs to /scores, and the same
// specs as HardwareModel fields for tests that create machines directly.
type Changes = { threads?: number; totalGb?: number; gpus?: unknown[] };

export function testProfile({ threads = 8, totalGb = 15.5, gpus = [] }: Changes = {}) {
	return {
		version: 2,
		cpu: { model: "Test CPU", cores: threads, threads, singleThreadMBps: 45, multiThreadMBps: 40 * threads },
		memory: { totalGb, bandwidthGBps: 10 },
		gpus,
	};
}

export function hardwareFields(changes: Changes = {}) {
	const { cpu, memory, gpus } = testProfile(changes);
	return { cpu, memory, gpus };
}
