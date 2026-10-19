# Agent manager

`index.js` exports `ProtocolServer` and `AgentManager`. This module transports provider commands and retrieves output. Authentication, assignment persistence, execution policy, blockchain consensus and object storage remain external adapters. There is no database, JWT issuer, container executor or local quorum implementation here.

## Protocol ports

`new ProtocolServer(options)` requires these adapters:

| Port | Contract |
| --- | --- |
| `authenticate(token)` | Resolve `{ id, wallet }` only for a current provider credential; reject expired, revoked or unauthorized credentials. An optional `scope` must equal `provider`. Called again after mapping HELLO and for each incoming frame. |
| `repository.getAssignedJob(jobId, providerId)` | Return the provider's authorized job or `null`. The repository owns assignment/status policy. Jobs expose `id`, `dockerImage`, `requirements`, `window` and `deadlineAt` for image handoff. |
| `onHello(provider, specs)` | Record an authenticated provider connection and optional specs. |
| `onHeartbeat(provider)` | Refresh the coordinator's provider availability. |
| `onAccept(provider, jobId)` | Record acceptance; its return value becomes the `ACCEPTED` payload. It does not automatically start execution. |
| `onFailure(provider, jobId, message)` / `onIdle(provider, jobId)` | Delegate execution failure and stopped-workload acknowledgement. |
| `getAssignment(provider)` | Return a reconnect assignment `{ id, ... }` or `null`. Ownership is rechecked before notification. |

Optional `pool` implements `get(wallet)`, `register(provider)` and `remove(wallet)`: disconnect removes idle capacity and preserves busy reservations with `lastHeartbeat: 0`. Optional `onDisconnect(provider)` receives a best-effort notification. Asynchronous availability adapters must avoid refreshing disconnected sessions after delayed work completes.

`listen({ key, cert, host = '127.0.0.1', port = 4001 })` accepts PEM certificate material and requires TLS 1.3. Clients must verify the certificate and hostname. `close()` closes connections and rejects outstanding output requests. The certificate helper under `test/` is solely for local tests.

Frames are UTF-8 JSON followed by a newline. HELLO must arrive within five seconds. One connection per wallet is allowed; handlers run in order. Input frames default to 12 MiB, buffered writes to twice that limit, output bytes to 8 MiB, and heartbeat/output timeouts to 30 seconds. No authentication fallback exists. Fatal authentication/framing errors close the connection; recoverable business errors return `ERROR`.

The coordinator calls asynchronous `sendAssignment(wallet, jobId)` and `sendDockerImage(wallet, job)` explicitly. The latter sends the stored registry image reference, not image bytes. The coordinator owns the decision to start execution; an `ACCEPT_ACK` alone does not trigger it. Callbacks should finish promptly and must not await output from their own paused connection.

## Output retrieval

`requestOutput(jobId, wallet, { signal, timeoutMs, providerId })` sends:

```json
{ "type": "REQUEST_OUTPUT", "requestId": "generated-id", "jobId": "assigned-job" }
```

The provider echoes the exact job ID and request ID:

```json
{
  "type": "RESULT",
  "requestId": "generated-id",
  "jobId": "assigned-job",
  "payload": { "resultBase64": "b3V0cHV0", "sha256": "64 hexadecimal characters", "filename": "result.txt" }
}
```

Only the requested provider/session/job can complete the request. Unsolicited or late results are rejected. Timeout, cancellation, disconnect and explicit revocation remove pending requests. At most four requests per session and 128 overall may be pending. The transport returns `{ bytes, sha256, filename, providerId, wallet }`; transport acknowledgement confirms receipt only.

`new AgentManager({ providerTransport, objectStorage, repository, maxOutputBytes })` uses:

- `providerTransport.requestOutput(jobId, wallet, { signal, providerId })` with the response above.
- `repository.getAssignedJob(jobId, providerId)` to check assignment access.
- `objectStorage.put(bytes, { jobId, providerId, hash, filename })` returning an opaque storage reference.
- `objectStorage.get(reference, { signal })` returning a `Uint8Array` or `Buffer`.

`collectOutput({ jobId, providerId, wallet, expectedHash, signal })` requires an expected SHA-256 hash supplied by the caller, such as one observed from the blockchain manager. It checks provider identity, byte size, actual SHA-256 and the provider's declared hash before storage. It returns the reference and verified metadata. `requestAnswer(reference, { expectedHash, signal })` verifies retrieved bytes against that external hash again. Hash inputs accept 64 hexadecimal characters with an optional `0x` prefix; stored metadata uses lowercase hexadecimal without the prefix.
