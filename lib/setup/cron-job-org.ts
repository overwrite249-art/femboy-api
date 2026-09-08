/**
 * One-shot, root-authorized provisioning for cron-job.org.
 *
 * The management API key is request-scoped. Only non-secret job metadata is
 * persisted. Job requests use CRON_SECRET, never the management API key.
 */
import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { getDb } from "../db/index.ts"
import { DuplicateKeyError } from "../db/driver.ts"
import { config } from "../config/env.ts"
import { ErrorCode, GatewayError, invalidRequest } from "../http/errors.ts"
import { asRecord, readLimitedText, safeJsonParse } from "../util/json.ts"
import { randomHex } from "../util/crypto.ts"

const API_ORIGIN = "https://api.cron-job.org"
const STATE_ID = "cron-job-org"
const CREATE_INTERVAL_MS = 13_000 // at most five creates in any rolling minute

export const CRON_PLAN = [
	{ name: "health-check", label: "Channel health", cron: "*/5 * * * *", minutes: range(5), hours: [-1] },
	{ name: "flush-usage", label: "Usage flushing", cron: "*/2 * * * *", minutes: range(2), hours: [-1] },
	{ name: "poll-tasks", label: "Task polling", cron: "* * * * *", minutes: [-1], hours: [-1] },
	{ name: "reconcile-quota", label: "Quota reconciliation", cron: "*/10 * * * *", minutes: range(10), hours: [-1] },
	{ name: "rollup", label: "Usage rollups", cron: "7 * * * *", minutes: [7], hours: [-1] },
	{ name: "refresh-pricing", label: "Pricing refresh", cron: "23 3 * * *", minutes: [23], hours: [3] },
	{ name: "expire-tokens", label: "Token expiration", cron: "41 * * * *", minutes: [41], hours: [-1] },
	{ name: "partition-maint", label: "Partition maintenance", cron: "13 4 * * *", minutes: [13], hours: [4] },
] as const

function range(step: number): number[] {
	return Array.from({ length: 60 / step }, (_, index) => index * step)
}

export type ConfiguredJob = { name: string; jobId: number }
type SetupState = { _id: string; origin: string; configuredAt: string; jobs: ConfiguredJob[] }
type SetupLease = { _id: string; owner: string; expiresAt: Date }
type Dependencies = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown> }

function setupError(message: string, status = 503): GatewayError {
	return new GatewayError({ code: ErrorCode.CONFIGURATION_ERROR, status, message })
}

/** Never derive the callback host from a client body or a forwarded Host header. */
export function schedulerOrigin(): string {
	let url: URL
	try {
		url = new URL(process.env.PUBLIC_BASE_URL?.trim() ?? "")
	} catch {
		throw setupError("Set PUBLIC_BASE_URL to the stable HTTPS production origin before scheduler setup.")
	}
	if (
		url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
		url.pathname !== "/" || url.port ||
		!url.hostname.includes(".") || url.hostname.endsWith(".localhost") ||
		url.hostname.endsWith(".local") || /^[\d.]+$/.test(url.hostname)
	) {
		throw setupError("PUBLIC_BASE_URL must be a stable HTTPS hostname without credentials, a port, or a path.")
	}
	return url.origin
}

function assertSetupEnvironment(): { origin: string; cronSecret: string } {
	if (process.env.VERCEL_ENV === "preview") {
		throw setupError("Configure the scheduler from the production deployment, not a preview.", 409)
	}
	const origin = schedulerOrigin()
	const cronSecret = config.cronSecret
	if (cronSecret.length < 32 || /[\r\n]/.test(cronSecret)) {
		throw setupError("Set a strong CRON_SECRET of at least 32 characters before scheduler setup.")
	}
	return { origin, cronSecret }
}

function validJobId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export async function schedulerStatus() {
	let origin: string | null = null
	let configurationError: string | null = null
	try {
		origin = assertSetupEnvironment().origin
	} catch (error) {
		configurationError = GatewayError.from(error).message
	}
	const state = await (await getDb()).collection<SetupState>("setup_state").findOne({ _id: STATE_ID })
	// Explicit allowlist: never return whole provider replies or stored records.
	const jobs = CRON_PLAN.map((job) => {
		const stored = state?.jobs?.find((row) => row.name === job.name)
		return {
			name: job.name, label: job.label, path: `/api/cron/${job.name}`, cron: job.cron,
			jobId: stored && validJobId(stored.jobId) ? stored.jobId : null,
		}
	})
	return {
		origin, configurationError, timezone: "UTC",
		configured: Boolean(origin && state?.origin === origin && jobs.every((job) => job.jobId)),
		configuredAt: state?.configuredAt ?? null, jobs,
	}
}

export async function configureScheduler(apiKeyInput: unknown, dependencies: Dependencies = {}) {
	if (
		typeof apiKeyInput !== "string" || apiKeyInput.trim().length < 16 ||
		apiKeyInput.length > 512 || /[^\x21-\x7e]/.test(apiKeyInput.trim())
	) {
		throw invalidRequest("Enter a valid cron-job.org API key from Console → Settings.")
	}
	const apiKey = apiKeyInput.trim()
	const { origin, cronSecret } = assertSetupEnvironment()
	const fetchApi = dependencies.fetch ?? globalThis.fetch
	const pause = dependencies.sleep ?? sleep
	const deadline = Date.now() + 200_000
	const leases = (await getDb()).collection<SetupLease>("setup_leases")
	const owner = randomHex(24)
	const leaseId = `${STATE_ID}:${createHash("sha256").update(origin).digest("hex")}`
	const expiresAt = new Date(Date.now() + 300_000)

	try {
		await leases.insertOne({ _id: leaseId, owner, expiresAt })
	} catch (error) {
		if (!DuplicateKeyError.is(error)) throw error
		const reclaimed = await leases.findOneAndUpdate(
			{ _id: leaseId, expiresAt: { $lte: new Date() } },
			{ $set: { owner, expiresAt } },
		)
		if (!reclaimed || reclaimed.owner !== owner) throw setupError("Scheduler setup is already running. Retry in five minutes.", 409)
	}

	async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
		const remaining = deadline - Date.now()
		if (remaining <= 0) throw setupError("Scheduler setup timed out. Rerun setup to finish any remaining jobs.", 504)
		let response: Response
		try {
			response = await fetchApi(API_ORIGIN + path, {
				method,
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "error",
				cache: "no-store",
				signal: AbortSignal.timeout(Math.min(10_000, remaining)),
			})
		} catch {
			// Network errors can contain request headers/URLs. Do not attach a cause.
			throw setupError("Could not reach cron-job.org. Rerun setup to finish any remaining jobs.", 502)
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined)
			const messages: Record<number, string> = {
				401: "cron-job.org rejected the API key. Generate a valid key in Console → Settings.",
				403: "cron-job.org refused this server. Check the API key's IP restrictions.",
				429: "cron-job.org's API limit was reached. Wait before rerunning setup; existing jobs are preserved.",
			}
			throw setupError(messages[response.status] ?? "cron-job.org could not save the job. Review the account and rerun setup.", 502)
		}
		try {
			const text = await readLimitedText(response.body, 1024 * 1024, { timeoutMs: 10_000 })
			const parsed: unknown = safeJsonParse(text, { maxBytes: 1024 * 1024, maxDepth: 24, maxNodes: 30_000 })
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
			return asRecord(parsed)
		} catch {
			throw setupError("cron-job.org returned an invalid response. Rerun setup after checking the account.", 502)
		}
	}

	try {
		const listed = await call("GET", "/jobs")
		if (listed.someFailed !== false || !Array.isArray(listed.jobs)) {
			throw setupError("cron-job.org returned an incomplete job list. No jobs were changed; retry later.", 502)
		}
		const existing = listed.jobs.map(asRecord)
		const prefix = `femboy-api / ${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`
		// Validate every match before any write. Never modify someone else's jobs.
		const plan = CRON_PLAN.map((job) => {
			const url = `${origin}/api/cron/${job.name}`
			const title = `${prefix} / ${job.name}`
			const matches = existing.filter((row) => row.url === url)
			if (matches.length > 1 || matches.some((row) => row.title !== title || !validJobId(row.jobId))) {
				throw setupError("Conflicting jobs already target this app. Review them in cron-job.org before setup.", 409)
			}
			return { ...job, url, title, jobId: matches[0]?.jobId as number | undefined }
		})
		const jobs: ConfiguredJob[] = []
		let created = 0
		let updated = 0
		for (const job of plan) {
			if (job.jobId) {
				if (jobs.length) await pause(250)
			} else if (created > 0) {
				await pause(CREATE_INTERVAL_MS)
			}
			const payload = {
				job: {
					url: job.url, title: job.title, enabled: true,
					saveResponses: false, requestMethod: 0, requestTimeout: -1, redirectSuccess: false,
					auth: { enable: false, user: "", password: "" },
					extendedData: { headers: { Authorization: `Bearer ${cronSecret}` }, body: "" },
					notification: { onFailure: true, onFailureCount: 3, onSuccess: false, onDisable: true },
					schedule: {
						timezone: "UTC", expiresAt: 0, minutes: job.minutes, hours: job.hours,
						mdays: [-1], months: [-1], wdays: [-1],
					},
				},
			}
			if (job.jobId) {
				await call("PATCH", `/jobs/${job.jobId}`, payload)
				updated++
				jobs.push({ name: job.name, jobId: job.jobId })
			} else {
				const result = await call("PUT", "/jobs", payload)
				if (!validJobId(result.jobId)) throw setupError("cron-job.org did not confirm the job ID. Review the account before rerunning setup.", 502)
				created++
				jobs.push({ name: job.name, jobId: result.jobId })
			}
		}
		const configuredAt = new Date().toISOString()
		await (await getDb()).collection<SetupState>("setup_state").updateOne(
			{ _id: STATE_ID }, { $set: { origin, configuredAt, jobs } }, true,
		)
		return { origin, configuredAt, jobs, created, updated }
	} finally {
		// The owner token prevents a late invocation from releasing a newer lease.
		await leases.deleteOne({ _id: leaseId, owner }).catch(() => undefined)
	}
}