// DEV ONLY: fills the database with the dev.env wallets so the provider client,
// the contract tests and the event mock work against the real server.
//
//   npm run seed      (idempotent; MONGODB_URI as for the server)
//
// API keys (use as OFFBALANCE_API_KEY / Authorization: Bearer <key>):
//   dev, dev2, dev3, dev4   provider 1-4 (`python3 main.py --dev --provider N`)
//   dev-buyer               the buyer
//
// Job 1 is a fixture: alpine writing /output/result.txt, assigned to provider 1,
// matching what dev-server.ts hands out, so `assign 1 p1` in event_controller.py works.
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectDB, disconnectDB } from "./db.ts";
import {
	AccountModel, AuthTokenModel, CounterModel, hashToken, JobModel, TutorialModel,
} from "./models/index.ts";

const env = Object.fromEntries(
	readFileSync(path.join(import.meta.dirname, "..", "dev.env"), "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#") && l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const ALPINE = "docker.io/library/alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"; // 3.20

async function account(wallet: string, apiKey: string) {
	const address = wallet.toLowerCase();
	const acct = await AccountModel.findOneAndUpdate(
		{ walletIds: address },
		{ $setOnInsert: { walletIds: [address] } },
		{ upsert: true, returnDocument: "after" },
	);
	await AuthTokenModel.updateOne(
		{ tokenHash: hashToken(apiKey) },
		{ account: acct._id, wallet: address },
		{ upsert: true },
	);
	console.log(`${apiKey.padEnd(10)} -> ${address} (account ${acct._id})`);
	return acct;
}

await connectDB();

const buyer = await account(env.BUYER_ADDRESS, "dev-buyer");
const providers = [];
for (const n of [1, 2, 3, 4]) {
	providers.push(await account(env[`PROVIDER_${n}_ADDRESS`], n === 1 ? "dev" : `dev${n}`));
}

const job = await JobModel.findOneAndUpdate(
	{ onChainJobId: 1 },
	{
		$setOnInsert: {
			owner: buyer._id,
			providers: [providers[0]._id],
			submittedAt: new Date(),
			dockerImageDigest: ALPINE,
			command: ["sh", "-c", 'echo "result for job 1" > /output/result.txt'],
			cpuLimit: 1,
			memLimitMb: 256,
			maxPrice: "1",
			runningPrice: "1",
			minNodesToRunOn: 1,
			minNodesToAgree: 1,
			timeWindow: 60,
		},
	},
	{ upsert: true, returnDocument: "after", runValidators: true },
);
await AccountModel.updateOne({ _id: buyer._id }, { $addToSet: { submittedJobs: job._id } });
await AccountModel.updateOne({ _id: providers[0]._id }, { $addToSet: { takenJobs: job._id } });
// new jobs get ids after the fixture
await CounterModel.updateOne({ _id: "jobId" }, { $max: { seq: 1 } }, { upsert: true });
console.log("job 1 -> provider 1");

if (!(await TutorialModel.exists({}))) {
	await TutorialModel.create({
		text: [
			"1. Install Docker and the OffBalance provider client (client/ in the repo).",
			"2. Sign in on the website with your wallet; your session token is your API key.",
			"3. Run the client: it benchmarks your machine and reports the scores.",
			"4. Set your hourly price on the website. You'll be matched to jobs your machine meets.",
		].join("\n"),
	});
	console.log("tutorial");
}

await disconnectDB();
