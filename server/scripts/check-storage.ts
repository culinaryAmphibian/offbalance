import { randomUUID } from 'node:crypto';
import { createResultStore } from '../storage/results.ts';

const key = `connection-check/${randomUUID()}.txt`;
const sample = Buffer.from('OffBalance synthetic storage connection check\n');
let uploaded = false;
const store = createResultStore();
if (!store) {
  console.error('Result storage is disabled.');
  process.exitCode = 1;
} else {
  try {
    await store.put(key, sample);
    uploaded = true;
    const object = await store.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
    if (object.size !== sample.length || !Buffer.concat(chunks).equals(sample)) {
      throw new Error('Storage returned different bytes.');
    }
    console.log('Storage connection verified: synthetic upload and download matched.');
  } catch {
    console.error('Storage check failed. Check server-only configuration and bucket-scoped permissions. No credentials were printed.');
    process.exitCode = 1;
  } finally {
    if (uploaded) {
      try { await store.delete(key); console.log('Synthetic test object removed.'); }
      catch { console.error('Test object cleanup failed; remove connection-check objects from the private bucket.'); process.exitCode = 1; }
    }
  }
}
