import { createHash } from 'node:crypto';
import { assert } from '../errors.js';

const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizedHash = value => typeof value === 'string' && /^(?:0x)?[\da-f]{64}$/i.test(value) ? value.replace(/^0x/i, '').toLowerCase() : null;

/** Collects requested outputs against an externally observed hash; it never votes. */
export class AgentManager {
  constructor({ providerTransport, objectStorage, repository, maxOutputBytes = 8 * 1024 * 1024 }) {
    assert(typeof providerTransport?.requestOutput === 'function', 500, 'A provider output transport must be provided.');
    assert(typeof objectStorage?.put === 'function' && typeof objectStorage?.get === 'function', 500, 'Object storage put/get adapters must be provided.');
    assert(typeof repository?.getAssignedJob === 'function', 500, 'An assignment repository must be provided.');
    assert(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0, 500, 'Invalid output size limit.');
    Object.assign(this, { providerTransport, objectStorage, repository, maxOutputBytes });
  }

  checkedBytes(bytes, expectedHash) {
    assert(bytes instanceof Uint8Array && bytes.byteLength <= this.maxOutputBytes, 413, 'Output bytes exceed the allowed size or are invalid.');
    const hash = normalizedHash(expectedHash);
    assert(hash, 400, 'Provide the expected SHA-256 hash observed outside the agent manager.');
    const buffer = Buffer.from(bytes);
    assert(hashBytes(buffer) === hash, 422, 'Output bytes do not match the expected SHA-256 hash.');
    return { bytes: buffer, hash };
  }

  async collectOutput({ jobId, providerId, wallet, expectedHash, signal }) {
    signal?.throwIfAborted();
    assert(normalizedHash(expectedHash), 400, 'Provide the expected SHA-256 hash observed outside the agent manager.');
    assert(typeof providerId === 'string' && providerId.length > 0 && typeof wallet === 'string' && /^0x[\da-f]{40}$/i.test(wallet), 400, 'A provider identity and wallet are required.');
    assert(await this.repository.getAssignedJob(jobId, providerId), 403, 'This job is not assigned to the provider.');
    const output = await this.providerTransport.requestOutput(jobId, wallet, { signal, providerId });
    signal?.throwIfAborted();
    assert(output.providerId === providerId && output.wallet?.toLowerCase() === wallet.toLowerCase(), 403, 'Output came from a different provider.');
    const { bytes, hash } = this.checkedBytes(output.bytes, expectedHash);
    assert(normalizedHash(output.sha256) === hash, 422, 'The provider-declared hash does not match its output.');
    const filename = output.filename;
    assert(typeof filename === 'string' && filename.length > 0 && filename.length <= 120 && !/[\\/\x00-\x1f\x7f]/.test(filename), 400, 'Use an output filename without paths or control characters.');
    const metadata = { jobId, providerId, hash, filename };
    const reference = await this.objectStorage.put(bytes, metadata);
    return { reference, ...metadata, size: bytes.length };
  }

  async requestAnswer(reference, { expectedHash, signal } = {}) {
    signal?.throwIfAborted();
    assert(normalizedHash(expectedHash), 400, 'Provide the expected SHA-256 hash observed outside the agent manager.');
    const bytes = await this.objectStorage.get(reference, { signal });
    signal?.throwIfAborted();
    return this.checkedBytes(bytes, expectedHash).bytes;
  }
}
