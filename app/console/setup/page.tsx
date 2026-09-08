"use client"

import { useState } from "react"
import type { FormEvent } from "react"
import { api } from "../api.ts"
import { Callout, ErrorNote, Loading, Panel, formatDate, useApi } from "../ui.tsx"

type SchedulerStatus = {
	origin: string | null
	configurationError: string | null
	configured: boolean
	configuredAt: string | null
	jobs: { name: string; label: string; cron: string; path: string; jobId: number | null }[]
}

export default function SetupPage() {
	const status = useApi<SchedulerStatus>("/api/setup/cron-job-org")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const [result, setResult] = useState("")

	async function configure(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (busy) return
		const form = event.currentTarget
		const input = form.elements.namedItem("apiKey") as HTMLInputElement
		let apiKey = input.value
		input.value = ""
		setBusy(true)
		setError("")
		setResult("")
		try {
			const response = await api.post<{ created: number; updated: number }>(
				"/api/setup/cron-job-org", { apiKey },
			)
			setResult(`${response.created} jobs created, ${response.updated} updated. Check cron-job.org history to verify execution.`)
			status.reload()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Setup failed. Re-enter the API key to retry.")
		} finally {
			apiKey = ""
			setBusy(false)
		}
	}

	return (
		<div className="setup-content">
			<p className="setup-intro">
				Connect the scheduler to finish deployment. A <strong>cron-job.org API key is required</strong> to
				automatically configure the gateway&apos;s eight maintenance jobs.
			</p>
			<ErrorNote message={error || status.error} />
			{status.loading && !status.data ? <Loading rows={2} /> : null}
			{status.data?.configurationError ? <Callout tone="warn">{status.data.configurationError}</Callout> : null}
			{result ? <div role="status"><Callout tone="ok">{result}</Callout></div> : null}
			<section className="section">
				<Panel title="1. Get your API key" note="cron-job.org">
					<ol className="setup-steps">
						<li>Open the <a className="link" href="https://console.cron-job.org" target="_blank" rel="noreferrer">cron-job.org console</a> and sign in or create an account.</li>
						<li>Go to <strong>Settings</strong> and generate an <strong>API key</strong>.</li>
						<li>Enter it below. If you restrict API access by IP, allow your deployment&apos;s outbound IP addresses.</li>
					</ol>
					<p className="hint"><a className="link" href="https://docs.cron-job.org/rest-api.html" target="_blank" rel="noreferrer">Read the official API documentation ↗</a></p>
				</Panel>
			</section>
			<section className="section">
				<Panel title="2. Configure maintenance jobs" note="root account only">
					<p className="setup-copy">
						The API key is used once on the server; it is not saved in the database,
						browser storage, or application logs. The scheduler stores your
						server&apos;s <code>CRON_SECRET</code> to authenticate its requests.
					</p>
					{status.data?.origin ? <p className="hint setup-origin">Target: <strong>{status.data.origin}</strong></p> : null}
					<form className="setup-form" onSubmit={configure} autoComplete="off">
						<div className="field">
							<label htmlFor="cron-api-key">cron-job.org API key</label>
							<input id="cron-api-key" name="apiKey" type="password" required minLength={16} maxLength={512}
								autoComplete="off" spellCheck={false} disabled={busy || !status.data || Boolean(status.data.configurationError)}
								aria-describedby="cron-key-help" />
							<span className="hint" id="cron-key-help">Keep this key private. Do not add it to GitHub or share it in screenshots.</span>
						</div>
						<button className="btn btn-primary" type="submit"
							disabled={busy || !status.data || Boolean(status.data.configurationError)}>
							{busy ? "Configuring jobs…" : status.data?.configured ? "Update existing jobs" : "Connect cron-job.org"}
						</button>
						<p className="hint" role="status">
							{busy ? "Keep this page open. First-time setup takes about two minutes because of API rate limits." :
								"Rerunning setup updates matching jobs instead of duplicating them. Unrelated jobs are left alone."}
						</p>
					</form>
				</Panel>
			</section>
			{status.data ? <section className="section">
				<Panel title="Maintenance schedule" note="UTC">
					<p className="hint">
						{status.data.configured ? `Last configured: ${formatDate(status.data.configuredAt)}. This is saved setup status, not a live execution check.` :
							"Not configured for this production origin yet."}
					</p>
					<div className="setup-jobs">
						{status.data.jobs.map((job) => <div className="setup-job" key={job.name}>
							<div><strong>{job.label}</strong><div className="hint">{job.jobId ? `Job #${job.jobId}` : "Pending setup"}</div></div>
							<code>{job.cron}</code>
						</div>)}
					</div>
					<p className="hint">No native Vercel cron jobs are installed. Check the external scheduler&apos;s execution history after setup and monitor timeout or failure notices.</p>
				</Panel>
			</section> : null}
		</div>
	)
}