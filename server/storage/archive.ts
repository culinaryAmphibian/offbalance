import { createHash } from 'node:crypto';
import { extract } from 'tar-stream';

export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 1000;
export class ArchiveError extends Error {}
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();

function safePath(name: string): boolean {
	return Boolean(name) && Buffer.byteLength(name) <= 4096 && !/[\\\x00-\x1f\x7f]/.test(name) &&
		!name.startsWith('/') && !/^[A-Za-z]:/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..');
}

// tar readers disagree about concatenated archives and missing end markers. Admit
// one complete archive only; never extract provider-controlled paths on the host.
function validateFraming(bytes: Buffer) {
	if (bytes.length < 1024 || bytes.length % 512 || bytes.length > MAX_ARCHIVE_BYTES) throw new ArchiveError('Invalid tar archive size');
	let offset = 0, headers = 0;
	while (offset < bytes.length) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every(b => b === 0)) {
			if (bytes.length - offset < 1024 || !bytes.subarray(offset).every(b => b === 0)) throw new ArchiveError('Invalid tar end marker');
			return;
		}
		if (++headers > MAX_ENTRIES * 2) throw new ArchiveError('Too many tar headers');
		const field = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
		if (!/^[0-7]+$/.test(field)) throw new ArchiveError('Invalid tar entry size');
		const size = parseInt(field, 8);
		if (!Number.isSafeInteger(size) || size > MAX_ARCHIVE_BYTES) throw new ArchiveError('Tar entry is too large');
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	throw new ArchiveError('Missing tar end marker');
}

export async function inspectArchive(bytes: Buffer): Promise<{ hash: string; archiveHash: string; files: number }> {
	validateFraming(bytes);
	const parser = extract();
	const entries: { name: string; kind: string; digest: Buffer }[] = [];
	const names = new Set<string>(), links = new Set<string>();
	let total = 0, count = 0;
	const consume = (async () => {
		for await (const stream of parser) {
			const header = stream.header;
			const name = header.type === 'directory' ? header.name.replace(/\/$/, '') : header.name;
			if (!safePath(name) || names.has(name)) throw new ArchiveError('Unsafe or duplicate tar path');
			names.add(name);
			if (++count > MAX_ENTRIES) throw new ArchiveError('Too many archive entries');
			if (!['file', 'directory', 'symlink'].includes(header.type)) throw new ArchiveError('Only files, directories and safe symlinks are supported');
			if (!Number.isSafeInteger(header.size) || header.size < 0 || header.size > MAX_ARCHIVE_BYTES || (header.type !== 'file' && header.size !== 0)) throw new ArchiveError('Invalid tar entry size');
			const digest = createHash('sha256');
			let size = 0;
			for await (const item of stream) {
				const chunk = Buffer.from(item as Uint8Array);
				size += chunk.length;
				total += chunk.length;
				if (total > MAX_ARCHIVE_BYTES || size > header.size) throw new ArchiveError('Archive contents exceed the size limit');
				digest.update(chunk);
			}
			if (size !== header.size) throw new ArchiveError('Truncated tar entry');
			if (header.type === 'symlink') {
				if (!safePath(header.linkname)) throw new ArchiveError('Unsafe symlink target');
				links.add(name);
				entries.push({ name, kind: 'L', digest: sha256(header.linkname) });
			} else if (header.type === 'file') entries.push({ name, kind: 'F', digest: digest.digest() });
		}
	})();
	parser.end(bytes);
	try { await consume; }
	catch (error) { parser.destroy(); throw error instanceof ArchiveError ? error : new ArchiveError('Malformed tar archive'); }
	for (const name of names) {
		const parts = name.split('/');
		for (let i = 1; i < parts.length; i++) {
			if (links.has(parts.slice(0, i).join('/'))) throw new ArchiveError('Archive path traverses a symlink');
		}
	}
	const outer = createHash('sha256');
	for (const entry of entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
		const name = Buffer.from(entry.name), length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(name.length));
		outer.update(entry.kind).update(length).update(name).update(entry.digest);
	}
	return { hash: outer.digest('hex'), archiveHash: sha256(bytes).toString('hex'), files: entries.length };
}
