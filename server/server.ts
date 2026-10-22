import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { connectDB, disconnectDB } from './db.ts';
import { Builder } from './services/builder.ts';
import { Chain } from './services/chain.ts';
import { handleChainEvent } from './services/events.ts';
import { Matcher } from './services/matcher.ts';
import { Orchestrator } from './services/orchestrator.ts';
import { createHttpsServer, httpsOptions } from './https.ts';

const tlsOptions = await httpsOptions();
await connectDB(config.mongodbUri);
const chain = await Chain.connect();
const matcher = new Matcher(chain);
// the server calls the contract's deadline-gated phase transitions
const orchestrator = chain?.canWrite ? new Orchestrator(chain) : null;
const builder = new Builder();
let server: Server | undefined;
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const closed = server && new Promise<void>((resolve, reject) => {
    server!.close(error => error ? reject(error) : resolve());
    server!.closeIdleConnections();
  });
  // Stop incoming provider requests and event callbacks before closing MongoDB.
  await Promise.all([closed, chain?.stop(), orchestrator?.stop()]);
  await matcher.idle().catch(error => console.error('Pending matching failed:', error));
  await disconnectDB();
}

try {
  await builder.failInterrupted();
  server = createHttpsServer(createApp({ chain, matcher, builder }), tlsOptions).listen(config.port);
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  console.log(`Server on https://localhost:${config.port} (${chain ? 'chain' : 'database-only'})`);
  console.log(builder.enabled ? `Builds: pushing to ${builder.repository}` : 'Builds: off (set REGISTRY_NAMESPACE to enable)');
  await chain?.listen(async event => {
    await handleChainEvent(event, matcher);
    orchestrator?.onEvent(event);
  });
  await matcher.ping();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
  }
} catch (error) {
  await shutdown();
  throw error;
}
