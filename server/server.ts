// The real backend: MongoDB + the OffBalance contract.
//
//   cd server && npm start      # needs MongoDB; the chain is optional (see config.ts)
//   npm run seed                # dev accounts/API keys from ../dev.env
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { connectDB } from "./db.ts";
import { Builder } from "./services/builder.ts";
import { Chain } from "./services/chain.ts";
import { handleChainEvent } from "./services/events.ts";
import { Matcher } from "./services/matcher.ts";

await connectDB(config.mongodbUri);
const chain = await Chain.connect();
const matcher = new Matcher(chain);
const builder = new Builder();
await builder.failInterrupted();
console.log(builder.enabled
	? `Builds: pushing to ${builder.repository}`
	: "Builds: off (set REGISTRY_NAMESPACE, see config.ts); jobs can still use existing images");

createApp({ chain, matcher, builder }).listen(config.port, () => {
	console.log(`Server on http://localhost:${config.port} (${chain ? `chain: ${config.contract} contract` : "no chain"})`);
});

void chain?.listen((event) => handleChainEvent(event, matcher));
void matcher.ping(); // jobs left waiting from before a restart
