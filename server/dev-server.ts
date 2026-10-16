// DEV ONLY: mock of the routes the provider client calls (client/server/ServerManager.py),
// with canned responses and in-memory state. Lets you run the client's real
// (non --dev) flow before the actual server exists.
//
//   cd server && npm run dev:mock
//   cd client && OFFBALANCE_API_KEY=dev PROVIDER_PRIVATE_KEY=<from dev.env> python3 main.py
//
// GET /dev/state shows everything clients have posted.
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";

const DEV_PORT = Number(process.env.PORT ?? 5000);
// which deployed contract to hand out: "mock" (OffBalanceEventMock, driven by
// client/dev/event_controller.py) or "real" (OffBalance)
const CONTRACT = process.env.CONTRACT ?? "mock";
const DEPLOYMENT_FILE = path.join(import.meta.dirname, "..", "blockchain", "deployments", "localhost.json");

type Scores = { cpu: number; gpu: number | null; mem: number };

// in-memory state, keyed by bearer token (= the client's API key)
const scoresByToken = new Map<string, Scores>();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // ServerManager.post_benchmark sends form data

// log every request so you can see what the client does
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`, Object.keys(req.body ?? {}).length ? req.body : "");
  next();
});

// any non-empty bearer token is accepted; it just identifies the client
function requireToken(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) {
    res.status(401).json({ error: "missing Authorization: Bearer <api key>" });
    return;
  }
  res.locals.token = token;
  next();
}

// read on every request so a redeploy is picked up without restarting
function contractAddress(): string {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
  return CONTRACT === "real" ? deployment.address : deployment.eventMock.address;
}

app.get("/contract_address", requireToken, (_req: Request, res: Response) => {
  try {
    res.json({ address: contractAddress() });
  } catch (e) {
    res.status(503).json({ error: `can't read ${DEPLOYMENT_FILE}; run \`npm run dev\` in blockchain/`, detail: String(e) });
  }
});

app.post("/scores", requireToken, (req: Request, res: Response) => {
  const { cpu, gpu, mem } = req.body ?? {};
  if (cpu === undefined || mem === undefined) {
    res.status(400).json({ error: "cpu and mem are required" });
    return;
  }
  // form data arrives as strings; gpu is absent when the client sends None
  const scores: Scores = { cpu: Number(cpu), gpu: gpu === undefined ? null : Number(gpu), mem: Number(mem) };
  scoresByToken.set(res.locals.token, scores);
  res.status(201).json({ ok: true, scores });
});

app.get("/jobManifest/:jobId", requireToken, (req: Request, res: Response) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isInteger(jobId) || jobId < 0) {
    res.status(400).json({ error: "jobId must be a non-negative integer" });
    return;
  }
  // same manifest for every job; real images should be pinned by digest so
  // every provider runs byte-identical code
  res.json({
    manifest: {
      jobId,
      image: "docker.io/library/alpine:3.20",
      command: ["sh", "-c", `echo "result for job ${jobId}"`],
      env: {},
      input_url: null,
      timeout_s: 60,
      cpu_limit: 1,
      mem_limit_mb: 256,
    },
  });
});

app.get("/dev/state", (_req: Request, res: Response) => {
  res.json({ contract: CONTRACT, scores: Object.fromEntries(scoresByToken) });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `no mock route for ${req.method} ${req.path}` });
});

app.listen(DEV_PORT, () => {
  console.log(`Mock server on http://localhost:${DEV_PORT}, handing out the ${CONTRACT} contract (CONTRACT=real|mock)`);
});
