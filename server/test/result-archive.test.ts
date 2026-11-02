import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pack, type Header } from 'tar-stream';
import { inspectArchive, MAX_ARCHIVE_BYTES } from '../storage/archive.ts';

async function archive(entries: { name: string; data?: string; type?: Header['type']; linkname?: string }[]): Promise<Buffer> {
	const tar = pack();
	for (const { data = '', ...header } of entries) tar.entry(header, data);
	tar.finalize();
	const chunks: Buffer[] = [];
	for await (const item of tar) chunks.push(Buffer.from(item as Uint8Array));
	return Buffer.concat(chunks);
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();
function directoryHash(entries: { name: string; data: string; kind?: string }[]) {
	const hash = createHash('sha256');
	for (const item of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
		const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(Buffer.byteLength(item.name)));
		hash.update(item.kind ?? 'F').update(length).update(item.name).update(digest(item.data));
	}
	return hash.digest('hex');
}

test('directory digest ignores tar order, metadata and directory headers', async () => {
	const entries = [{ name: 'sub/é.txt', data: 'hello\n' }, { name: '😀.txt', data: 'world' }];
	const first = await inspectArchive(await archive(entries));
	const other = await inspectArchive(await archive([{ name: 'sub/', type: 'directory' }, ...entries.toReversed()]));
	assert.equal(first.hash, directoryHash(entries));
	assert.equal(other.hash, first.hash);
	assert.notEqual(other.archiveHash, first.archiveHash);
	assert.equal(first.files, 2);
});

test('safe symlink targets are hashed as link strings without reading the host', async () => {
	const bytes = await archive([{ name: 'out.txt', data: 'hi' }, { name: 'alias', type: 'symlink', linkname: 'out.txt' }]);
	assert.equal((await inspectArchive(bytes)).hash, directoryHash([{ name: 'out.txt', data: 'hi' }, { name: 'alias', data: 'out.txt', kind: 'L' }]));
});

test('PAX paths retain their exact UTF8 name', async () => {
	const name = 'a/'.repeat(100) + 'résultat.txt';
	assert.equal((await inspectArchive(await archive([{ name, data: 'x' }]))).hash, directoryHash([{ name, data: 'x' }]));
});

test('rejects traversal, absolute/duplicate paths, hardlinks, specials and symlink traversal', async () => {
	for (const entry of [{ name: '../escape', data: 'x' }, { name: '/absolute', data: 'x' }, { name: 'a\\b', data: 'x' },
		{ name: 'link', type: 'link' as const, linkname: 'out' }, { name: 'pipe', type: 'fifo' as const },
		{ name: 'link', type: 'symlink' as const, linkname: '../../etc/passwd' }]) {
		await assert.rejects(inspectArchive(await archive([entry])));
	}
	await assert.rejects(inspectArchive(await archive([{ name: 'same', data: '1' }, { name: 'same', data: '2' }])));
	await assert.rejects(inspectArchive(await archive([{ name: 'dir', type: 'symlink', linkname: 'other' }, { name: 'dir/file', data: 'x' }])));
});

test('rejects truncated, corrupt, concatenated and oversized archives', async () => {
	const valid = await archive([{ name: 'out', data: 'hi' }]);
	await assert.rejects(inspectArchive(valid.subarray(0, -512)));
	await assert.rejects(inspectArchive(valid.subarray(0, valid.length - 1024)));
	await assert.rejects(inspectArchive(Buffer.concat([valid, valid])));
	const corrupt = Buffer.from(valid); corrupt[1] ^= 1;
	await assert.rejects(inspectArchive(corrupt));
	await assert.rejects(inspectArchive(Buffer.alloc(MAX_ARCHIVE_BYTES + 512)));
});

test('empty archive matches empty-directory digest and member count is bounded', async () => {
	assert.equal((await inspectArchive(await archive([]))).hash, digest('').toString('hex'));
	await assert.rejects(inspectArchive(await archive(Array.from({ length: 1001 }, (_, i) => ({ name: `out-${i}`, data: '' })))));
});
