# Local result delivery and Cloudflare R2

The API defaults to private local files under `server/.local/results`. No R2
request is made unless `RESULT_STORAGE=r2` and `R2_ENABLED=true` are configured.
The HTTPS server binds to `127.0.0.1` by default. Publishing this source does not
deploy the server or provide access to its private environment files.

## Run locally

From `server/`:

```sh
npm ci
npm run storage:check
```

The check writes a tiny synthetic object, reads it back and deletes it. With
the default configuration this is entirely local. To start the full app, follow
the existing README's MongoDB, local certificate and frontend instructions.
`CHAIN=off` permits testing authenticated delivery without claiming blockchain
consensus, payment or a verified on-chain receipt.

## Activate R2 when ready

1. Sign into the Cloudflare dashboard. Open **Storage & databases > R2 Object
   Storage**. The account owner must complete subscription/terms acceptance.
2. Create a dedicated bucket named `offbalance-results`, using **Standard**
   storage. Leave public access, the `r2.dev` URL and custom domains disabled.
3. Add an object lifecycle rule that deletes objects after 30 days. The API
   independently stops serving an artifact after its recorded 30-day retention
   deadline. API expiry alone does not physically remove stored objects.
4. Under R2 API tokens, prepare an S3 token with **Object Read & Write** access
   restricted to this bucket. Avoid account administration permissions. Complete
   token creation yourself, and keep the displayed S3 Access Key ID and Secret
   Access Key private. A regular Cloudflare bearer API token is not an S3 secret.
5. In an interactive terminal, run the following from `server/`:

   ```sh
   npm run storage:configure
   npm run storage:check
   ```

The configurator hides both credentials while typing and writes only
`server/.env.r2.local`, which Git ignores, with permissions `0600`. Do not paste
secrets into chat, command arguments, tracked examples, screenshots, `dev.env`,
provider manifests, or any `VITE_*` variable. No SDK error details or secret
values are printed by the storage adapter/check. `npm start` reads `.env` then
`.env.r2.local`; restart the server after configuring it.

To return to local storage, move the ignored `.env.r2.local` file to a private
location outside the repository and restart. Existing R2 objects remain in R2;
the local backend cannot serve them. Change storage backends only before jobs
are running, or migrate the corresponding objects explicitly.

## Free allowance and local limits

R2 has usage-based overages, not a hard-capped free subscription. Cloudflare
budget alerts notify you but do not stop usage. A $1 alert is not a $1 maximum
bill. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and
[budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/).

This application's conservative limits are:

| Limit | Value |
|---|---:|
| Uncompressed archive size | 25 MiB |
| Archive entries | 1,000 |
| Lifetime R2 uploaded-byte reservations | 1,000,000,000 bytes |
| R2 upload attempts per UTC calendar month | 1,000 |
| R2 download attempts per UTC calendar month | 10,000 |

Reservations are persisted **before** sending requests. Failed requests count;
automatic SDK retries are disabled. Deleting an object does not reclaim the
lifetime upload budget. The private usage ledger is
`server/.local/r2-usage.json`; do not delete, replace or reset it to bypass a
limit. A stale `.lock` after a crash stops requests until its ownership and
usage are reconciled. Keep one coordinator and one ledger for this application.

These limits cover this process's S3 calls, not other applications, dashboard
activity, other buckets, stolen credentials, a different ledger or existing
account usage. They are safeguards, not a Cloudflare account spending cap.

## Delivery protocol

Providers send an authenticated `POST /provider/results/:jobId` with an
uncompressed `application/x-tar` body and `X-Result-Hash` containing the SHA256
directory digest already used by `RunManager.hash_dir`. No cloud credentials
are needed on a provider or in a browser.

The API checks assignment and delivery phase, safely parses files and relative
symlinks without extracting them, and recomputes the directory digest. In chain
mode it additionally requires the provider's revealed, agreed on-chain output
hash to equal `keccak256(directoryDigest)`. Only verified bytes are stored.
Metadata-only `hash`/`location` submissions are rejected.

An identical retry reuses its stored object and retries an unconfirmed receipt.
HTTP `202` means bytes were stored but the chain receipt is pending; an identical
upload can retry that receipt. The provider sends results on the delivery-phase
event using output retained in memory for its current run. Local mode never fabricates a verified chain
receipt. The buyer downloads a retained verified archive from authenticated
`GET /jobs/:jobId/result`; other accounts receive `403`. Storage keys stay on the
server. Legacy metadata-only records are not downloadable artifacts.

## Verification

```sh
npm run typecheck
npm run test:storage
MONGODB_URI=mongodb://127.0.0.1:27017 npm run test:storage
```

The R2 unit tests use injected fake clients; they do not contact Cloudflare.
Database tests create and remove isolated test databases. Only an explicit
connection check using configured R2 credentials exercises the real service.
