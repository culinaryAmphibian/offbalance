import { constants } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const MAX_RESULT_BYTES = 25 * 1024 * 1024;
const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../.local");

export class StorageError extends Error {
	readonly status: number;
	constructor(message: string, status = 503) { super(message); this.name = "StorageError"; this.status = status; }
}

export interface ResultStore {
	put(key: string, bytes: Buffer): Promise<void>;
	get(key: string): Promise<{ body: Readable; size: number }>;
	delete(key: string): Promise<void>;
}

function checkKey(key: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(key) || key.split("/").some(p => !p || p === "." || p === "..")) {
		throw new StorageError("Invalid result object key.", 400);
	}
}

function checkSize(bytes: Buffer): void {
	if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RESULT_BYTES) {
		throw new StorageError("Result must contain between 1 byte and 25 MiB.", 413);
	}
}

export class LocalResultStore implements ResultStore {
	readonly directory: string;
	constructor(directory = path.join(DEFAULT_ROOT, "results")) { this.directory = path.resolve(directory); }
	private filename(key: string): string { checkKey(key); return path.join(this.directory, key); }
	async put(key: string, bytes: Buffer): Promise<void> {
		checkSize(bytes);
		const file = this.filename(key);
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		// Publishing by hard link prevents partial downloads and preserves immutable keys.
		const pending = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(pending, bytes, { mode: 0o600, flag: "wx" });
			await link(pending, file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StorageError("Result object already exists.", 409);
			throw new StorageError("Local result could not be stored.");
		} finally { await rm(pending, { force: true }); }
	}
	async get(key: string): Promise<{ body: Readable; size: number }> {
		const file = this.filename(key);
		try {
			const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) { await handle.close(); throw new StorageError("Invalid stored result.", 502); }
			return { body: handle.createReadStream(), size: stat.size };
		} catch (error) {
			if (error instanceof StorageError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError("Result is no longer available.", 404);
			throw new StorageError("Local result could not be read.");
		}
	}
	async delete(key: string): Promise<void> {
		const file = this.filename(key);
		try { await unlink(file); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StorageError("Local result could not be deleted."); }
	}
}

type Ledger = { version: 1; uploadedBytes: number; months: Record<string, { reads: number; writes: number }> };
type Limits = { uploadedBytes: number; reads: number; writes: number };
const LIMITS: Limits = { uploadedBytes: 1_000_000_000, reads: 10_000, writes: 1_000 };

// Persist reservations BEFORE the request. Failed requests consume the local budget too.
// Lifetime byte accounting intentionally does not reclaim deleted data or reset each month.
export class R2Budget {
	private readonly filename: string;
	private readonly limits: Limits;
	private readonly now: () => Date;
	private pending: Promise<void> = Promise.resolve();
	constructor(filename = path.join(DEFAULT_ROOT, "r2-usage.json"), limits: Partial<Limits> = {}, now = () => new Date()) {
		this.filename = path.resolve(filename);
		this.limits = { ...LIMITS, ...limits };
		this.now = now;
		for (const key of Object.keys(LIMITS) as (keyof Limits)[]) {
			if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > LIMITS[key]) {
				throw new StorageError("Invalid R2 usage limit; limits may only be lowered.");
			}
		}
	}
	reserve(operation: "reads" | "writes", bytes = 0): Promise<void> {
		if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new StorageError("Invalid R2 usage reservation.", 400));
		const next = this.pending.then(() => this.reserveLocked(operation, bytes));
		this.pending = next.catch(() => {});
		return next;
	}
	private async reserveLocked(operation: "reads" | "writes", bytes: number): Promise<void> {
		const lock = `${this.filename}.lock`;
		await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
		try { await mkdir(lock, { mode: 0o700 }); }
		catch { throw new StorageError("R2 usage accounting is locked; no cloud request was sent."); }
		const temporary = `${this.filename}.${randomUUID()}.tmp`;
		try {
			let ledger: Ledger;
			try { ledger = JSON.parse(await readFile(this.filename, "utf8")) as Ledger; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StorageError("R2 usage accounting is unreadable; no cloud request was sent.");
				ledger = { version: 1, uploadedBytes: 0, months: {} };
			}
			if (ledger.version !== 1 || !Number.isSafeInteger(ledger.uploadedBytes) || ledger.uploadedBytes < 0 ||
				!ledger.months || typeof ledger.months !== "object" || Array.isArray(ledger.months) ||
				Object.entries(ledger.months).some(([month, usage]) => !/^\d{4}-\d{2}$/.test(month) || !usage ||
					![usage.reads, usage.writes].every(n => Number.isSafeInteger(n) && n >= 0))) {
				throw new StorageError("R2 usage accounting is invalid; no cloud request was sent.");
			}
			const month = this.now().toISOString().slice(0, 7);
			const usage = ledger.months[month] ?? { reads: 0, writes: 0 };
			if (usage[operation] >= this.limits[operation] || ledger.uploadedBytes + bytes > this.limits.uploadedBytes) {
				throw new StorageError("Local R2 usage budget reached; no cloud request was sent.");
			}
			usage[operation]++;
			ledger.months[month] = usage;
			ledger.uploadedBytes += bytes;
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(JSON.stringify(ledger)); await handle.sync(); }
			finally { await handle.close(); }
			await rename(temporary, this.filename);
			const directory = await open(path.dirname(this.filename), "r");
			try { await directory.sync(); } finally { await directory.close(); }
		} catch (error) {
			if (error instanceof StorageError) throw error;
			throw new StorageError("R2 usage accounting failed; no cloud request was sent.");
		} finally {
			await rm(temporary, { force: true });
			await rm(lock, { recursive: true, force: true });
		}
	}
}

type R2Options = { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; usageFile?: string };

export class R2ResultStore implements ResultStore {
	private readonly client: Pick<S3Client, "send">;
	private readonly bucket: string;
	private readonly budget: R2Budget;
	constructor(options: R2Options, client?: Pick<S3Client, "send">, budget?: R2Budget) {
		if (!/^[a-f0-9]{32}$/.test(options.accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) ||
			!options.accessKeyId || !options.secretAccessKey) throw new StorageError("R2 server configuration is incomplete or invalid.");
		this.bucket = options.bucket;
		this.budget = budget ?? new R2Budget(options.usageFile);
		this.client = client ?? new S3Client({
			region: "auto", endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
			credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
			maxAttempts: 1, requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
			requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
		});
	}
	async put(key: string, bytes: Buffer): Promise<void> {
		checkKey(key); checkSize(bytes);
		await this.budget.reserve("writes", bytes.length);
		try {
			await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes,
				ContentType: "application/x-tar", ContentLength: bytes.length, StorageClass: "STANDARD", IfNoneMatch: "*" }),
				{ abortSignal: AbortSignal.timeout(35_000) });
		} catch { throw new StorageError("R2 result upload failed.", 502); }
	}
	async get(key: string): Promise<{ body: Readable; size: number }> {
		checkKey(key);
		await this.budget.reserve("reads");
		try {
			const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }),
				{ abortSignal: AbortSignal.timeout(35_000) });
			if (!(result.Body instanceof Readable) || !Number.isSafeInteger(result.ContentLength) ||
				result.ContentLength! < 1 || result.ContentLength! > MAX_RESULT_BYTES) {
				if (result.Body instanceof Readable) result.Body.destroy();
				throw new StorageError("R2 returned an invalid result.", 502);
			}
			return { body: result.Body, size: result.ContentLength! };
		} catch (error) {
			if (error instanceof StorageError) throw error;
			const code = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
			throw new StorageError(code === 404 ? "Result is no longer available." : "R2 result download failed.", code === 404 ? 404 : 502);
		}
	}
	async delete(key: string): Promise<void> {
		checkKey(key);
		// R2 DELETE requests are free; never block cleanup on an exhausted upload budget.
		try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(35_000) }); }
		catch { throw new StorageError("R2 result cleanup failed.", 502); }
	}
}

export function createResultStore(env: NodeJS.ProcessEnv = process.env): ResultStore | null {
	switch (env.RESULT_STORAGE ?? "local") {
		case "off": return null;
		case "local": return new LocalResultStore(env.RESULT_LOCAL_DIR);
		case "r2": {
			if (env.R2_ENABLED !== "true") throw new StorageError("R2 access is disabled; set R2_ENABLED=true after account setup.");
			return new R2ResultStore({ accountId: env.R2_ACCOUNT_ID ?? "", bucket: env.R2_BUCKET ?? "",
				accessKeyId: env.R2_ACCESS_KEY_ID ?? "", secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
				usageFile: env.R2_USAGE_FILE });
		}
		default: throw new StorageError("RESULT_STORAGE must be off, local, or r2.");
	}
}
