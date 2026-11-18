// Soak test: the full local stack (chain, HTTPS server, MongoDB, 3 real provider clients running
// real Docker jobs) under continuous use for SOAK_MINUTES (default 60). Jobs are submitted back to
// back; every 5th one's output is random, so it must end in NO_QUORUM, and the rest must be PAID.
// Measured throughout:
//   - every job's outcome and how long it took
//   - stuck jobs: not finished within JOB_TIMEOUT
//   - event lag: how long the server's database takes to show a job's final status after the chain
//   - memory (RSS) of the server and each provider client, sampled every minute
// Fails (exit 1) on a stuck job, a wrong outcome, an event lag over 30 s, or server memory that
// keeps growing (more than 150 MB above its level after the first 5 minutes). Writes a JSON report.
//
//   MONGODB_URI=... TEST_PYTHON=../client/.venv/bin/python SOAK_MINUTES=60 npm run test:soak
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Status, until } from "./driver.ts";
import { missingRequirements, startLocalStack } from "./local-stack.ts";

const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);
const JOB_TIMEOUT = 300_000;
const MAX_LAG_MS = 30_000;
const MAX_SERVER_GROWTH_MB = 150;

const missing = missingRequirements();
if (missing) {
	console.log(`soak test skipped: ${missing}`);
	process.exit(0);
}

const rssMb = (pid: number | undefined) => {
	try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024; }
	catch { return NaN; }
};
const minutes = (ms: number) => (ms / 60_000).toFixed(1);

const local = await startLocalStack({ providers: 3 });
const { stack } = local;
const started = Date.now();
const end = started + MINUTES * 60_000;
type JobRecord = { id: number; expected: string; outcome: string; seconds: number; lagMs: number | null };
const jobs: JobRecord[] = [];
const memory: { minute: number; serverMb: number; clientsMb: number[] }[] = [];
const problems: string[] = [];

const sample = () => memory.push({ minute: Math.round((Date.now() - started) / 60_000),
	serverMb: rssMb(local.server.pid), clientsMb: local.providers.map(p => rssMb(p.child.pid)) });
sample();
const sampler = setInterval(sample, 60_000);

console.log(`[soak] stack up; running jobs for ${MINUTES} minutes (logs: ${local.logs})`);
try {
	for (let n = 1; Date.now() < end; n++) {
		const random = n % 5 === 0;
		const t0 = Date.now();
		const id = await stack.submitJob({ name: `soak ${n}`, maxPrice: "0.01", providers: 3, agree: 2, window: 30,
			command: ["sh", "-c", random ? "head -c 16 /dev/urandom | od -An -tx1 > /output/r" : `echo "soak ${n}" > /output/r`] });
		const expected = random ? "NO_QUORUM" : "PAID";
		let outcome = "STUCK";
		let lagMs: number | null = null;
		try {
			const status = await stack.waitForStatus(id, [Status.PAID, Status.NO_QUORUM], JOB_TIMEOUT);
			outcome = status === Status.PAID ? "PAID" : "NO_QUORUM";
			const onChain = Date.now();
			const dbStatus = outcome === "PAID" ? "PAYOUT" : "NO_QUORUM";
			await until("the database", async () => (await stack.job(id)).status === dbStatus, 60_000);
			lagMs = Date.now() - onChain;
		} catch (error) {
			problems.push(`job ${id}: ${(error as Error).message}`);
		}
		const record = { id, expected, outcome, seconds: Math.round((Date.now() - t0) / 1000), lagMs };
		jobs.push(record);
		if (outcome !== expected) problems.push(`job ${id}: expected ${expected}, got ${outcome}`);
		if (lagMs !== null && lagMs > MAX_LAG_MS) problems.push(`job ${id}: the database lagged the chain by ${lagMs} ms`);
		console.log(`[soak] ${minutes(Date.now() - started)} min: job ${id} ${outcome} in ${record.seconds}s (db lag ${lagMs ?? "?"} ms)`);
		if (outcome === "STUCK") break; // the providers are tied up; later jobs would only queue behind it
	}
} finally {
	clearInterval(sampler);
	sample();
	const baseline = memory.find(m => m.minute >= 5) ?? memory[0];
	const last = memory.at(-1)!;
	const growth = last.serverMb - baseline.serverMb;
	if (MINUTES >= 10 && growth > MAX_SERVER_GROWTH_MB) problems.push(`server memory grew ${growth.toFixed(0)} MB after warm-up`);
	const lags = jobs.map(j => j.lagMs).filter((l): l is number => l !== null);
	const report = {
		minutes: Number(minutes(Date.now() - started)), jobs: jobs.length,
		paid: jobs.filter(j => j.outcome === "PAID").length, noQuorum: jobs.filter(j => j.outcome === "NO_QUORUM").length,
		stuck: jobs.filter(j => j.outcome === "STUCK").length,
		secondsPerJob: { min: Math.min(...jobs.map(j => j.seconds)), max: Math.max(...jobs.map(j => j.seconds)),
			mean: Math.round(jobs.reduce((a, j) => a + j.seconds, 0) / Math.max(1, jobs.length)) },
		dbLagMs: { max: Math.max(0, ...lags), mean: Math.round(lags.reduce((a, b) => a + b, 0) / Math.max(1, lags.length)) },
		serverMb: { start: memory[0].serverMb.toFixed(0), afterWarmup: baseline.serverMb.toFixed(0), end: last.serverMb.toFixed(0) },
		clientsMb: { start: memory[0].clientsMb.map(m => m.toFixed(0)), end: last.clientsMb.map(m => m.toFixed(0)) },
		problems, jobsDetail: jobs, memory,
	};
	const file = path.join(local.logs, "soak-report.json");
	writeFileSync(file, JSON.stringify(report, null, 2));
	console.log(`[soak] report: ${JSON.stringify({ ...report, jobsDetail: undefined, memory: undefined }, null, 1)}`);
	console.log(`[soak] full report: ${file}`);
	if (problems.length) console.error(local.logTails(15));
	await local.stop();
	process.exitCode = problems.length ? 1 : 0;
}
