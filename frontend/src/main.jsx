import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api";
import { createDemoApi } from "./demoApi";
import { dateLabel, shortWallet } from "./jobs";
import { useAuth } from "./useAuth";
import { useResource } from "./useResource";
import JobForm from "./components/JobForm";
import JobDetail, { ResourceError, Status } from "./components/JobDetail";
import ProviderSetup from "./components/ProviderSetup";
import "./stylesheets/app.css";

const demo = import.meta.env.VITE_API_MODE === "demo";
const api = demo
	? createDemoApi()
	: createApi({ baseUrl: import.meta.env.VITE_API_BASE_URL || "/api" });

function App() {
	const auth = useAuth(api, demo);
	return (
		<>
			<header className="header">
				<div className="header-inner">
					<a className="brand" href="#/" aria-label="Offbalance home">
						<svg
							width="28"
							height="30"
							viewBox="0 0 28 30"
							fill="none"
							aria-hidden="true">
							<path
								d="M3 8h8v20H3zM17 2h8v20h-8z"
								fill="currentColor"
							/>
						</svg>
						offbalance<span className="brand-dot">.</span>
					</a>
					<div className="account">
						{demo && <span className="demo">Local demo</span>}
						{auth.session && (
							<>
								<span
									className="wallet"
									title={auth.session.account.wallet}>
									{shortWallet(auth.session.account.wallet)}
								</span>
								<button
									className="text-button"
									onClick={() => auth.disconnect()}>
									Sign out
								</button>
							</>
						)}
					</div>
				</div>
			</header>
			<main>
				{auth.session ? (
					<Workspace key={auth.session.account.wallet} />
				) : (
					<section
						className="sign-in"
						aria-labelledby="signin-heading">
						<h1 id="signin-heading">Your compute, coordinated.</h1>
						<p className="muted">
							Sign in to submit workloads and follow their
							results.
						</p>
						{auth.error && (
							<p className="notice error" role="alert">
								{auth.error}
							</p>
						)}
						<button
							className="button primary"
							onClick={auth.connect}
							disabled={auth.pending}>
							{auth.pending
								? "Check your wallet…"
								: demo
									? "Enter demo"
									: "Connect wallet & sign in"}
						</button>
						<p className="muted form-note">
							{demo
								? "Sample data only. No wallet, payments, or compute jobs are used. Changes reset on reload."
								: "Sign a message in your wallet. Signing in does not send a transaction."}
						</p>
					</section>
				)}
			</main>
		</>
	);
}

function Workspace() {
	const [hash, setHash] = useState(window.location.hash || "#/");
	const [view, setView] = useState("buyer");
	const [createdId, setCreatedId] = useState(null);
	useEffect(() => {
		const changed = () => {
			setHash(window.location.hash || "#/");
			window.scrollTo(0, 0);
		};
		window.addEventListener("hashchange", changed);
		return () => window.removeEventListener("hashchange", changed);
	}, []);
	if (hash === "#/jobs/new")
		return (
			<JobForm
				api={api}
				onCreated={(id) => {
					setCreatedId(id);
					window.location.hash = `/jobs/${encodeURIComponent(id)}`;
				}}
			/>
		);
	if (hash === "#/provider") return <ProviderSetup api={api} />;
	const match = hash.match(/^#\/jobs\/([^/]+)$/);
	if (match) {
		let id;
		try {
			id = decodeURIComponent(match[1]);
		} catch {
			return <NotFound />;
		}
		return (
			<JobDetail
				key={id}
				api={api}
				id={id}
				notice={createdId === id ? "Job submitted." : ""}
			/>
		);
	}
	if (!["#/", "#"].includes(hash)) return <NotFound />;
	return <Overview key={view} view={view} setView={setView} />;
}

function Overview({ view, setView }) {
	const load = useCallback((signal) => api.listJobs(view, signal), [view]);
	const { data, error, loading, refresh } = useResource(load, 10000);
	const isBuyer = view === "buyer";
	const jobs = data?.jobs;
	const summary = data?.summary;
	const stats = [
		["Active jobs", summary?.activeJobs],
		["Completed jobs", summary?.completedJobs],
		[
			isBuyer ? "Total spent" : "Total earned",
			isBuyer ? summary?.totalSpent : summary?.totalEarned,
			"ETH",
		],
	];
	if (!isBuyer) stats.push(["Current stake", summary?.currentStake, "ETH"]);
	return (
		<>
			<div className="page-heading">
				<h1>Overview</h1>
				<div
					className="view-switch"
					role="group"
					aria-label="Account view">
					{["buyer", "provider"].map((role) => (
						<button
							key={role}
							aria-pressed={view === role}
							onClick={() => setView(role)}>
							{role === "buyer" ? "Buyer" : "Provider"}
						</button>
					))}
				</div>
			</div>
			<section
				className={`stats${isBuyer ? "" : " stats-provider"}`}
				aria-label={`${view} summary`}>
				{stats.map(([label, value, unit]) => (
					<div className="stat" key={label}>
						<h2>{label}</h2>
						<p>
							{value ?? "—"}
							{unit && <span className="unit">{unit}</span>}
						</p>
					</div>
				))}
			</section>
			{error && <ResourceError message={error} retry={refresh} />}
			<section className="jobs" aria-labelledby="jobs-heading">
				<div className="section-heading">
					<h2 id="jobs-heading">
						{isBuyer ? "Your jobs" : "Assigned jobs"}
					</h2>
					<div className="actions">
						<button
							className="text-button"
							onClick={refresh}
							disabled={loading}>
							Refresh
						</button>
						<a
							className="button primary"
							href={isBuyer ? "#/jobs/new" : "#/provider"}>
							{isBuyer ? "Submit job" : "Provider setup"}
						</a>
					</div>
				</div>
				{loading && !data && (
					<p className="muted" role="status">
						Loading jobs…
					</p>
				)}
				{data && !Array.isArray(jobs) && (
					<p className="notice error" role="alert">
						The server did not return a jobs list.
					</p>
				)}
				{Array.isArray(jobs) &&
					(jobs.length ? (
						<div
							className="table-scroll"
							role="region"
							aria-label="Jobs table"
							tabIndex="0">
							<table>
								<thead>
									<tr>
										<th>Job</th>
										<th>Status</th>
										<th>Providers</th>
										<th>Submitted</th>
										<th className="numeric">
											{isBuyer ? "Budget" : "Earnings"}
										</th>
									</tr>
								</thead>
								<tbody>
									{jobs.map((job) => (
										<tr key={job.id}>
											<td>
												<a
													className="job-name"
													href={`#/jobs/${encodeURIComponent(job.id)}`}>
													{job.name || job.id}
												</a>
											</td>
											<td>
												<Status value={job.status} />
											</td>
											<td className="mono">
												{job.providerCount ?? "—"} /{" "}
												{job.k ?? "—"}
											</td>
											<td className="date">
												{dateLabel(job.createdAt)}
											</td>
											<td className="numeric mono">
												{(isBuyer
													? job.maxPrice
													: job.earnings) ?? "—"}
												<span className="currency">
													{" "}
													ETH
												</span>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<div className="panel empty-state">
							<p>
								{isBuyer
									? "No jobs yet."
									: "No assigned jobs yet."}
							</p>
							<p className="muted">
								{isBuyer
									? "Submit a container workload to get started."
									: "Jobs appear here when the coordinator assigns them to you."}
							</p>
						</div>
					))}
			</section>
		</>
	);
}

function NotFound() {
	return (
		<>
			<h1>Page not found</h1>
			<a className="back-link" href="#/">
				← Overview
			</a>
		</>
	);
}

createRoot(document.getElementById("root")).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
