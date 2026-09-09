"use client"
import { useRef, useState } from "react"
import type { FormEvent } from "react"
import Link from "next/link"
import { ArrowRight, ArrowUpRight, PlugZap, ShieldCheck } from "lucide-react"
import { CopyButton } from "../../components/interface.tsx"
import { api } from "../api.ts"
import {
	Callout,
	ErrorNote,
	Loading,
	PageHeader,
	Panel,
	Pill,
	RefreshButton,
	formatDate,
	useApi,
} from "../ui.tsx"
type SchedulerStatus = {
	origin: string | null
	configurationError: string | null
	configured: boolean
	configuredAt: string | null
	jobs: {
		name: string
		label: string
		cron: string
		path: string
		jobId: number | null
	}[]
}
const CADENCE: Record<string, string> = {
	"*/5 * * * *": "Every 5 minutes",
	"*/2 * * * *": "Every 2 minutes",
	"* * * * *": "Every minute",
	"*/10 * * * *": "Every 10 minutes",
	"7 * * * *": "Hourly, at :07",
	"23 3 * * *": "Daily, 03:23 UTC",
	"41 * * * *": "Hourly, at :41",
	"13 4 * * *": "Daily, 04:13 UTC",
}
export default function SetupPage() {
	const status = useApi<SchedulerStatus>("/api/setup/cron-job-org")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const [result, setResult] = useState("")
	const pending = useRef(false)
	async function configure(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (pending.current) return
		const input = event.currentTarget.elements.namedItem(
			"apiKey",
		) as HTMLInputElement
		let apiKey = input.value
		input.value = ""
		pending.current = true
		setBusy(true)
		setError("")
		setResult("")
		try {
			const response = await api.post<{ created: number; updated: number }>(
				"/api/setup/cron-job-org",
				{ apiKey },
			)
			setResult(
				`${response.created} jobs created, ${response.updated} updated. Check cron-job.org history to verify execution.`,
			)
			status.reload()
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Setup failed. Re-enter your key to try again.",
			)
		} finally {
			apiKey = ""
			pending.current = false
			setBusy(false)
		}
	}
	const data = status.data
	return (
		<div className="setup-content">
			<PageHeader
				eyebrow="System"
				title="Deployment"
				description="Connect the maintenance scheduler once. Health checks, usage flushing and housekeeping then run on schedule."
				actions={
					<>
						<RefreshButton onClick={status.reload} loading={status.loading} />
						<a
							className="btn"
							href="https://console.cron-job.org"
							target="_blank"
							rel="noreferrer"
						>
							Open scheduler <ArrowUpRight size={15} />
						</a>
					</>
				}
			/>
			<ErrorNote message={error || status.error} />
			{status.loading && !data ? <Loading rows={3} /> : null}
			{data?.configurationError ? (
				<Callout tone="warn">{data.configurationError}</Callout>
			) : null}
			{result ? (
				<div role="status">
					<Callout tone="ok">{result}</Callout>
				</div>
			) : null}
			{data ? (
				<div className="setup-status-banner">
					<div>
						<strong>
							{data.configured
								? "Scheduler configuration saved"
								: "Scheduler not configured"}
						</strong>
						<p>
							{data.configured
								? `${data.jobs.filter((job) => job.jobId).length} jobs linked · Last configured ${formatDate(data.configuredAt)}`
								: "Eight maintenance jobs are created from a cron-job.org API key."}
						</p>
					</div>
					<Pill tone={data.configured ? "ok" : "warn"}>
						{data.configured ? "Configured" : "Setup needed"}
					</Pill>
				</div>
			) : null}
			<div className="setup-grid section">
				<Panel
					title={
						data?.configured
							? "Update your scheduler connection"
							: "Connect cron-job.org"
					}
					note="Root access only"
				>
					<p className="setup-copy">
						Your cron-job.org API key is used once on the server. It is not
						saved in the database, browser storage, or application logs. The
						scheduler stores your server’s <code>CRON_SECRET</code> to
						authenticate maintenance requests.
					</p>
					{data?.origin ? (
						<div className="endpoint-box section">
							<label>Maintenance target</label>
							<div>
								<code>{data.origin}</code>
								<CopyButton
									value={data.origin}
									label="Copy target origin"
									iconOnly
								/>
							</div>
						</div>
					) : null}
					<form className="setup-form" onSubmit={configure} autoComplete="off">
						<div className="field">
							<label htmlFor="cron-api-key">cron-job.org API key</label>
							<input
								id="cron-api-key"
								name="apiKey"
								type="password"
								required
								minLength={16}
								maxLength={512}
								placeholder="Paste your scheduler key"
								autoComplete="off"
								spellCheck={false}
								disabled={busy || !data || Boolean(data.configurationError)}
								aria-describedby="cron-key-help"
							/>
							<span className="hint" id="cron-key-help">
								The field is cleared when submitted. Keep your key private.
							</span>
						</div>
						<button
							className="btn btn-primary"
							type="submit"
							disabled={busy || !data || Boolean(data.configurationError)}
						>
							<PlugZap size={17} />
							{busy
								? "Configuring jobs…"
								: data?.configured
									? "Update existing jobs"
									: "Connect scheduler"}
						</button>
						<p className="hint" role="status">
							{busy
								? "Keep this page open. Initial setup can take about two minutes because of API rate limits."
								: "Existing matching jobs are updated, not duplicated. Unrelated jobs are left alone."}
						</p>
					</form>
				</Panel>
				<Panel title="Connection guide" note="Before you begin">
					<ol className="setup-steps">
						<li>
							<strong>Get a management key</strong>
							<br />
							Sign in to{" "}
							<a
								className="link"
								href="https://console.cron-job.org"
								target="_blank"
								rel="noreferrer"
							>
								cron-job.org
							</a>
							, open Settings, and generate an API key.
						</li>
						<li>
							<strong>Allow your deployment</strong>
							<br />
							If you restrict API access by IP, allow your deployment’s outbound
							addresses.
						</li>
						<li>
							<strong>Connect, then inspect</strong>
							<br />
							Enter the key here. After setup, check the scheduler’s execution
							history for successful runs.
						</li>
					</ol>
					<a
						className="subtle-link"
						href="https://docs.cron-job.org/rest-api.html"
						target="_blank"
						rel="noreferrer"
					>
						Scheduler API documentation <ArrowUpRight size={15} />
					</a>
					<Link className="subtle-link" href="/setup">
						Full deployment guide <ArrowRight size={15} />
					</Link>
				</Panel>
			</div>
			{data ? (
				<section className="section">
					<div className="section-head">
						<h2 className="section-title">Maintenance jobs</h2>
						<span className="section-note">
							{data.jobs.length} jobs · all times UTC
						</span>
						<Pill tone="info">External scheduler</Pill>
					</div>
					<div className="job-grid">
						{data.jobs.map((job) => (
							<article className="job-card" key={job.name}>
								<div className="job-card-head">
									<Pill tone={job.jobId ? "ok" : "idle"}>
										{job.jobId ? "Configured" : "Not connected"}
									</Pill>
								</div>
								<h3>{job.label}</h3>
								<p>{CADENCE[job.cron] || "Custom schedule"}</p>
								<div className="job-card-code">
									<code>{job.cron}</code>
									<CopyButton
										value={job.cron}
										label={"Copy schedule for " + job.label}
										iconOnly
									/>
								</div>
								<span className="hint">
									{job.jobId
										? `Job #${job.jobId}`
										: "A job ID will appear after setup"}
								</span>
							</article>
						))}
					</div>
					<p className="privacy-note">
						<ShieldCheck size={16} />
						These are saved configuration records, not live execution results.
						Check cron-job.org history for failures or timeouts. No native
						Vercel cron jobs are installed.
					</p>
				</section>
			) : null}
		</div>
	)
}
