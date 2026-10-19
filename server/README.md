# Server manager components

This branch implements the three server responsibilities from the project diagram. Import them from `server/index.js`; importing the package starts no listeners or RPC connections.

| Directory | Responsibility |
| --- | --- |
| [`matching/`](matching/README.md) | Fetch scheduling inputs through a repository interface, filter/rank providers, quote cost, queue work, and reserve live capacity. |
| [`agent-manager/`](agent-manager/README.md) | Authenticated TLS provider communication, correlated output retrieval, byte-integrity checks, and upload through an object-storage interface. |
| [`blockchain-manager/`](blockchain-manager/README.md) | Read-only event monitoring, confirmed-log backfill, checkpoint recovery, and forwarding observations to the application. |

The database owner supplies repository/checkpoint implementations. The authentication owner supplies provider credential verification. The contract owner supplies contract addresses/ABIs and transaction handling. Object storage is provided through a small adapter. These components do not create accounts, define MongoDB schemas/indexes, allocate database IDs, run database migrations, decide consensus, sign receipts, or send contract transactions.

The complete earlier local prototype is preserved on the **local** `server-prototype-backup` branch. Its browser API, MongoDB Compose setup, accounts/sessions and local quorum lifecycle are excluded from this scoped branch. The frontend is maintained separately on `frontend` and in PR #5.

## Integration boundaries

- Matching returns selected providers and calls an injected `onMatched(job, providers, quote)` handler. The integrating application owns durable assignment writes and any subsequent blockchain transaction. Repository metadata alone never establishes a live provider session.
- Agent Manager receives an expected output hash from its caller; it checks retrieved bytes against that hash. It does not choose the winning hash or mark a job completed. Uploaded-byte hashes and the Python client's directory-tree hash are different formats and need an agreed output envelope before full runner integration.
- Blockchain Manager only reads the provided RPC interface. Its callback reports decoded events; application/database owners decide how those observations are recorded. Checkpoint persistence is injected, with no database driver included here. Event handlers must be idempotent because retry/recovery can replay observations.
- TLS remains the selected provider control transport. Credential checks and assigned-provider authorization remain required. No permissive development token is supplied by these modules.

The Python client on main still uses blockchain events and HTTP requests. Its existing sources, contracts, development mock, and contract tests are preserved unchanged. This refactor does not claim an end-to-end Python-to-TLS execution bridge or provide the full browser REST API.

## Check locally

Use Node.js 22 or newer and OpenSSL for the temporary TLS test certificates. From `server/`:

```sh
npm ci
npm run test:managers
```

Manager tests use explicit repository, authentication, object-storage and read-only chain fixtures. TLS checks use verified local certificates. No MongoDB server, blockchain deployment, private signing key, or Docker workload is required.

The existing `dev:mock`, `test:dev`, `test:real` and `test` scripts belong to the upstream provider HTTP application and remain unchanged. In particular, its real API entry point is still the upstream placeholder; `test:real` is not the acceptance command for these three manager modules.
