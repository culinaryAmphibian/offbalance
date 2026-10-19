# Agent manager

`index.ts` exports `AgentManager` and its strict TypeScript adapter contracts. The server uses the same HTTPS API for provider control, benchmark reports, manifests and result receipts. There is no separate socket listener or newline-delimited message protocol.

## Provider control

Every control request uses `Authorization: Bearer <token>` from wallet sign-in. Credentials are checked for revocation and current linked-wallet membership on every request.

| Request | Behavior |
| --- | --- |
| `POST /provider/heartbeat` | Refresh benchmarked hardware availability; returns `{ ok, heartbeatTimeoutMs }`. Send periodically within that timeout, including while executing a job. Request body cannot replace benchmark scores. |
| `GET /provider/assignment` | Read `{ assignment }` from MongoDB, or `{ assignment: null }`. Providers can poll or recover an assignment after restarting. |
| `POST /provider/jobs/:jobId/accept` | Check assignment ownership and return `{ ok, assignment }`; retries are safe. |
| `POST /provider/jobs/:jobId/idle` | Acknowledge a stopped workload without releasing unfinished on-chain work. |
| `POST /provider/jobs/:jobId/error` | Report `{ message }` for an assigned job, without releasing unfinished on-chain work. |
| `GET /jobManifest/:jobId` | Retrieve the authorized manifest using the Python client's existing HTTP contract. |
| `POST /provider/results/:jobId` | Record `{ hash, location }` after output has been uploaded to object storage; preserve delivery-phase and assignment checks. |

Blockchain events continue to trigger execution and govern terminal status. Assignment polling is a recovery mechanism and does not authorize a provider to start a workload ahead of the contract. Heartbeat expiry removes idle capacity from matching; an HTTP disconnect does not abandon a running assignment. Only terminal lifecycle events release it.

## Output retrieval adapters

`new AgentManager({ providerTransport, objectStorage, repository, maxOutputBytes })` remains available for verified output collection:

- `providerTransport.requestOutput(jobId, wallet, { signal, providerId })` returns `{ bytes, sha256, filename, providerId, wallet }`.
- `repository.getAssignedJob(jobId, providerId)` checks assignment access.
- `objectStorage.put(bytes, { jobId, providerId, hash, filename })` returns an opaque reference.
- `objectStorage.get(reference, { signal })` returns a `Uint8Array` or `Buffer`.

The transport is an injected adapter; the HTTPS server does not implement remote byte collection or initiate a request back to a provider. An application using `AgentManager` must supply an adapter that retrieves an uploaded artifact or calls an authenticated HTTP service. The result-receipt endpoint records an artifact location, not its bytes.

`collectOutput({ jobId, providerId, wallet, expectedHash, signal })` requires an externally supplied expected SHA-256, such as one observed from the blockchain. It verifies assignment, provider identity, byte size, actual SHA-256 and the declared hash before storage. `requestAnswer(reference, { expectedHash, signal })` verifies retrieved bytes again. Hashes accept 64 hexadecimal characters with an optional `0x` prefix; metadata uses lowercase hexadecimal without the prefix.

`AssignmentRepository.getAssignedJob` accepts string or numeric job IDs and returns an authorized `Assignment`, `null` or `undefined`, synchronously or through a promise. `AgentManager<Reference>` and `ObjectStorage<Reference>` support a storage-specific reference type; the default is a string.
