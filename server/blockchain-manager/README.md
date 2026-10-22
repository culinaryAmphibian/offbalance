# Blockchain event monitor

This component reads confirmed contract events and hands them to an injected callback. It owns polling, ABI decoding, event order, cursor progression, and reorg detection. The contract owner supplies the deployed address, event ABI, chain ID, and deployment block. The database owner supplies checkpoint persistence and event effects.

It has no signer, private key, transaction submission, provider assignment, receipt signing, execution, consensus, or settlement implementation. Construction performs no RPC calls. No production RPC is configured or started by default.

## Ports

```ts
import { BlockchainMonitor } from './blockchain-manager/index.ts';

const monitor = new BlockchainMonitor({
  provider,           // Read-only getBlockNumber(), getBlock(number), getLogs(filter).
  address,            // Supplied contract deployment address.
  abi,                // Supplied nonanonymous event declarations/full ABI.
  chainId,            // Explicit positive chain identifier; caller verifies provider/network.
  startBlock,         // Use the supplied deployment block to avoid scanning irrelevant history.
  checkpointStore: {
    load: () => loadCheckpoint(),
    save: checkpoint => persistCheckpoint(checkpoint),
  },
  onEvent: event => applyEventIdempotently(event),
  onError: error => reportError(error),
});

await monitor.pollOnce(); // One bounded range, useful for backfill/tests.
monitor.start();          // Immediate poll, then periodic polling/retry.
// Later, outside event/checkpoint callbacks:
await monitor.stop();
```

The TypeScript module exports `MonitorOptions`, `ReadonlyProvider`, `RpcBlock`, `RpcLog`, `LogFilter`, `Checkpoint`, `CheckpointStore`, `MonitorEvent`, `PollResult`, `ReorgDetails`, and `ReorgPolicy` for integration adapters. Port methods accept synchronous values or promises; `MonitorEvent.args` retains ethers' decoded `Result` type. Runtime input validation remains active for JavaScript callers.

All identifiers/functions above are caller-supplied ports, not bundled database or RPC implementations. `ServerBlockchainManager` is an export alias for the same monitor; it adds no transaction methods.

Provider methods may return promises. `getBlock(number)` must return `{number, hash, ...}`. `getLogs({address, fromBlock, toBlock})` returns Ethereum logs with `address`, `blockNumber`, `blockHash`, `transactionHash`, `transactionIndex`, `index` (or `logIndex`), `topics`, and `data`. Only the configured address and events decoded by the supplied ABI are delivered. Malformed owned logs and inconsistent block hashes fail without advancing the cursor.

The checkpoint port loads `null` initially and saves `{blockNumber, blockHash}` after an entire range succeeds. Scope this store to the chain, contract, deployment, and ABI integration; do not reuse another integration's checkpoint. Store failures propagate. The monitor contains no database adapter. `monitor.checkpoint` returns a copy of the last observed/saved checkpoint.

Defaults: `startBlock=0`, `confirmations=6`, `batchSize=500` (maximum 10000), `maxLogs=10000`, `pollIntervalMs=1000`, `maxBackoffMs=30000`. A poll reads at most one batch ending at `head - confirmations`; empty ranges advance too. Oversized log responses fail closed, so reduce the batch size for a dense contract. Choose the contract's actual deployment block explicitly.

`pollOnce({signal})` supports an optional abort signal. Concurrent polls serialize. `start()` is idempotent while running and retries transient failures with exponential delay capped at `maxBackoffMs`; `onError` receives failures and `lastError` records the latest. `reconnect(newProvider)` changes the provider for subsequent polls without mixing providers within a range. `running` reports whether the polling loop is active.

`stop()` cancels queued work, prevents subsequent event callbacks/checkpoint commits, wakes the retry timer, and waits for current work to settle. An already-issued provider call, callback, or checkpoint write cannot be forcibly canceled through these ports. Supply finite RPC timeouts; do not await `stop()` from inside a callback it must wait for. An explicit later `pollOnce()` or `start()` can resume.

## Delivery and replay

Events are sorted by block number, transaction index, and log index; duplicate log IDs within one response are delivered once. Callback fields are:

```text
id, chainId, address, blockNumber, blockHash,
transactionHash, transactionIndex, logIndex, name, signature, args
```

`args` is ethers' decoded `Result`, including named fields and possible `bigint` values. The persistence owner chooses its serialization/schema. IDs include chain ID, contract address, block hash, transaction hash, and log index.

Delivery is **at least once**. A callback failure or failed checkpoint save leaves the cursor unchanged and replays that range, including callbacks that already succeeded. Persistence must deduplicate IDs or otherwise apply events idempotently. There is no transaction coupling between `onEvent` and checkpoint storage. Block hashes are checked before dispatch and again before checkpointing; callbacks still need a reconciliation policy for events orphaned during or after processing.

## Reorg policy

Every poll compares the stored checkpoint hash with its current canonical block. A mismatch throws `ReorgError` before scanning/delivering more events. The background loop reports that error and stops; it does not silently accept a new hash.

An integration may explicitly supply:

```ts
onReorg: async ({ checkpoint, actualBlockHash }) => {
  // The persistence owner chooses a common ancestor and reconciles orphaned effects.
  await reconcileOrphanedEvents(checkpoint, actualBlockHash);
  return { rewindTo: commonAncestorBlock };
}
```

`rewindTo` must be below the old cursor and at least `startBlock - 1`. With `startBlock=0`, `-1` means replay from genesis. The monitor verifies the rewind block, saves its canonical hash (or null at `-1`), and replays on the next poll. Reconciliation must itself be idempotent because checkpoint persistence can fail after it runs. Choosing the ancestor and undoing orphaned database effects remain outside this component.

Run the fixture suite from the repository root:

```sh
node --test server/test/blockchain-manager.test.js
```

Tests use supplied event declarations and in-memory provider/checkpoint fixtures. They exercise confirmation bounds, sorted decoding/deduplication, cursor resumption, retries, address filtering, reorg policies, and cancellation. They use no live chain or wallet.

## MongoDB service integration

`services/chain.ts` uses this monitor with `adapters/checkpoints.ts`. Checkpoints persist both block number and canonical block hash in MongoDB, under a namespace containing chain ID and contract address. Event callbacks receive stable IDs and ABI-named arguments; failed event effects or checkpoint writes replay the range. Reorgs stop monitoring until the database owner reconciles the orphaned effects.

The event listener pins the deployment address and ABI when connecting. Restart the server after redeploying or changing the deployment file. Transaction methods reread deployment metadata and reject a changed chain/address until reconnecting, so a replacement deployment never inherits the previous contract's checkpoint. Existing numeric `chainCursor` sequence records are not imported because they contain no block hash or contract scope.

`CHAIN_CONFIRMATIONS` overrides the confirmation depth; the default is zero for local chains 1337/31337 and six elsewhere. `CHAIN_START_BLOCK` defaults to zero and should be set to the contract deployment block. `CHAIN_POLL_MS` controls polling. `CHAIN=off` skips connecting. Contract writes require `SERVER_PRIVATE_KEY` and throw if it is absent. With a key, the server also drives each job's deadline-gated phase transitions (`services/orchestrator.ts`). Shutdown awaits monitor completion before destroying its read-only provider.
