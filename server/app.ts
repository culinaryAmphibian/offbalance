import express, { type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import { accountRoutes } from "./routes/account.ts";
import { authRoutes } from "./routes/auth.ts";
import { imageRoutes } from "./routes/images.ts";
import { clientRoutes } from "./routes/client.ts";
import type { Deps } from "./routes/deps.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { providerRoutes } from "./routes/provider.ts";
import { RegistryError } from "./services/registry.ts";

const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173,https://localhost:5173,https://127.0.0.1:5173").split(",");

export function createApp(deps: Deps, { log = true } = {}) {
	const app = express();
	app.use(express.json({ limit: "1mb" })); // room for a Dockerfile in POST /builds
	app.use(express.urlencoded({ extended: false })); // ServerManager.post_benchmark sends form data

	// the React app (vite dev server) calls us cross-origin with a bearer token
	app.use((req: Request, res: Response, next: NextFunction) => {
		const origin = req.headers.origin;
		if (origin && CORS_ORIGINS.includes(origin)) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
			res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		}
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}
		next();
	});

	if (log) {
		app.use((req: Request, _res: Response, next: NextFunction) => {
			console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
			next();
		});
	}

	app.use(authRoutes());
	app.use(clientRoutes(deps));
	app.use(imageRoutes(deps));
	app.use(jobRoutes(deps));
	app.use(providerRoutes(deps));
	app.use(accountRoutes());

	app.use((req: Request, res: Response) => {
		res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
	});

	app.use((err: Error & { code?: number }, _req: Request, res: Response, _next: NextFunction) => {
		if (err instanceof RegistryError) {
			res.status(err.status === 401 ? 502 : err.status).json({ error: err.message });
		} else if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
			res.status(400).json({ error: err.message });
		} else if (err.code === 11000) {
			res.status(409).json({ error: "already exists", detail: err.message });
		} else if (err.name === "SyntaxError" && "body" in err) {
			res.status(400).json({ error: "malformed JSON body" });
		} else if ((err as { type?: string }).type === "entity.too.large") {
			res.status(413).json({ error: "request body too large" });
		} else {
			console.error(err);
			res.status(500).json({ error: "internal error" });
		}
	});

	return app;
}
