import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { configureScheduler, schedulerOrigin, schedulerStatus, CRON_PLAN } from "../../lib/setup/cron-job-org.ts"
import { handleSchedulerSetup } from "../../lib/setup/controller.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { setDb } from "../../lib/db/index.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { createUser, createToken } from "../../lib/admin/store.ts"
import { createSession, SESSION_COOKIE, CSRF_HEADER } from "../../lib/admin/session.ts"

const environment = { ...process.env }
const originalFetch = globalThis.fetch
const API_KEY = "scheduler-management-fixture-not-a-real-key"
const CRON_SECRET = "scheduler-callback-fixture-not-a-real-secret"
const ORIGIN = "https://gateway.test"
let db: MemoryDatabase

beforeEach(() => {
	db = new MemoryDatabase()
	setDb(db)
	setRedis(new MemoryRedis())
	Object.assign(process.env, {
		NODE_ENV: "test", PUBLIC_BASE_URL: ORIGIN, CRON_SECRET,
		KEY_PEPPER: "scheduler-pepper-fixture", IP_HASH_SECRET: "scheduler-ip-fixture",
		SESSION_SECRET: "scheduler-session-fixture", MIN_AUTH_LATENCY_MS: "0",
	})
	delete process.env.VERCEL_ENV
	delete process.env.ADMIN_ALLOWED_CIDRS
})

afterEach(() => {
	globalThis.fetch = originalFetch
	setDb(null)
	setRedis(null)
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key]
	}
	Object.assign(process.env, environment)
})

type Job = Record<string, unknown>
function existingJobs(): Job[] {
	const prefix = `femboy-api / ${createHash("sha256").update(ORIGIN).digest("hex").slice(0, 12)}`
	return CRON_PLAN.map((job, index) => ({
		jobId: index + 1, title: `${prefix} / ${job.name}`, url: `${ORIGIN}/api/cron/${job.name}`,
	}))
}

function provider(initial: Job[] = []) {
	const jobs = structuredClone(initial)
	const requests: { method: string; url: string; body?: { job: Job } }[] = []
	const waits: number[] = []
	let nextId = 100
	const fetchMock: typeof fetch = async (input, init) => {
		const url = String(input)
		assert.equal(new URL(url).origin, "https://api.cron-job.org")
		assert.equal(init?.redirect, "error")
		assert.equal(init?.cache, "no-store")
		assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${API_KEY}`)
		const method = init?.method ?? "GET"
		const body = init?.body ? JSON.parse(String(init.body)) as { job: Job } : undefined
		requests.push({ method, url, body })
		if (method === "GET") return Response.json({ jobs, someFailed: false })
		assert.ok(body)
		assert.ok(!JSON.stringify(body).includes(API_KEY))
		if (method === "PUT") {
			const jobId = nextId++
			jobs.push({ ...body.job, jobId })
			return Response.json({ jobId })
		}
		assert.equal(method, "PATCH")
		const jobId = Number(new URL(url).pathname.split("/").pop())
		const index = jobs.findIndex((job) => job.jobId === jobId)
		assert.ok(index >= 0)
		jobs[index] = { ...jobs[index], ...body.job }
		return Response.json({})
	}
	return { jobs, requests, waits, dependencies: { fetch: fetchMock, sleep: async (ms: number) => { waits.push(ms) } } }
}

function request(method = "GET", body?: unknown, headers: Record<string, string> = {}) {
	return new Request(`${ORIGIN}/api/setup/cron-job-org`, {
		method, headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

test("creates eight authorized jobs, paces writes, and persists no secret", async () => {
	const mock = provider()
	const result = await configureScheduler(API_KEY, mock.dependencies)
	assert.equal(result.created, 8)
	assert.equal(result.updated, 0)
	assert.deepEqual(mock.waits, Array(7).fill(13_000))
	for (const [index, job] of mock.jobs.entries()) {
		assert.equal(job.url, `${ORIGIN}/api/cron/${CRON_PLAN[index].name}`)
		assert.equal(job.enabled, true)
		assert.equal(job.saveResponses, false)
		assert.equal(job.redirectSuccess, false)
		assert.equal(job.requestMethod, 0)
		assert.deepEqual(job.extendedData, { headers: { Authorization: `Bearer ${CRON_SECRET}` }, body: "" })
		assert.deepEqual(job.schedule, {
			timezone: "UTC", expiresAt: 0, minutes: CRON_PLAN[index].minutes,
			hours: CRON_PLAN[index].hours, mdays: [-1], months: [-1], wdays: [-1],
		})
	}
	const status = await schedulerStatus()
	assert.equal(status.configured, true)
	for (const name of await db.listCollections()) {
		const stored = JSON.stringify(await db.collection<{ _id: string }>(name).find({}))
		assert.ok(!stored.includes(API_KEY))
		assert.ok(!stored.includes(CRON_SECRET))
	}
	const output = JSON.stringify({ result, status })
	assert.ok(!output.includes(API_KEY))
	assert.ok(!output.includes(CRON_SECRET))
})

test("rerunning setup updates instead of duplicating, leaving unrelated jobs unchanged", async () => {
	const unrelated = { jobId: 999, title: "unrelated", url: "https://another.test/task", enabled: false }
	const mock = provider([unrelated])
	await configureScheduler(API_KEY, mock.dependencies)
	const result = await configureScheduler(API_KEY, mock.dependencies)
	assert.equal(result.created, 0)
	assert.equal(result.updated, 8)
	assert.equal(mock.jobs.length, 9)
	assert.deepEqual(mock.jobs[0], unrelated)
	assert.equal(mock.requests.filter((r) => r.method === "PUT").length, 8)
	assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, 8)
})

test("expired setup leases can be reclaimed", async () => {
	const leaseId = `cron-job-org:${createHash("sha256").update(ORIGIN).digest("hex")}`
	await db.collection<{ _id: string; owner: string; expiresAt: Date }>("setup_leases").insertOne({
		_id: leaseId, owner: "expired-owner", expiresAt: new Date(0),
	})
	const mock = provider(existingJobs())
	assert.equal((await configureScheduler(API_KEY, mock.dependencies)).updated, 8)
	assert.equal(await db.collection<{ _id: string }>("setup_leases").countDocuments({}), 0)
})

test("concurrent setup is refused before duplicate API writes", async () => {
	const mock = provider(existingJobs())
	let release!: () => void
	let arrived!: () => void
	const ready = new Promise<void>((resolve) => { arrived = resolve })
	const hold = new Promise<void>((resolve) => { release = resolve })
	const original = mock.dependencies.fetch
	const first = configureScheduler(API_KEY, {
		...mock.dependencies,
		fetch: async (input, init) => {
			if (init?.method === "GET") { arrived(); await hold }
			return original(input, init)
		},
	})
	await ready
	await assert.rejects(configureScheduler(API_KEY, mock.dependencies), /already running/)
	release()
	await first
	assert.equal(mock.requests.length, 9)
})

for (const value of [undefined, "", "short", "line\nbreak-should-not-be-accepted", "x".repeat(513)]) {
	test(`invalid management key is rejected (${typeof value === "string" ? value.length : "missing"} chars)`, async () => {
		let calls = 0
		await assert.rejects(configureScheduler(value, { fetch: async () => { calls++; return Response.json({}) } }), /valid cron-job.org API key/)
		assert.equal(calls, 0)
	})
}

for (const origin of ["", "http://gateway.test", "https://user:pass@gateway.test", "https://gateway.test/path",
	"https://gateway.test?secret=x", "https://gateway.test#x", "https://127.0.0.1", "https://localhost",
	"https://gateway.test:8080", "https://node.local"]) {
	test(`rejects unsafe or unstable callback origin: ${origin || "(missing)"}`, () => {
		process.env.PUBLIC_BASE_URL = origin
		assert.throws(schedulerOrigin)
	})
}

test("preview deployments cannot reconfigure production jobs", async () => {
	process.env.VERCEL_ENV = "preview"
	await assert.rejects(configureScheduler(API_KEY), /not a preview/)
	assert.match((await schedulerStatus()).configurationError ?? "", /not a preview/)
})

test("requires a strong callback secret", async () => {
	process.env.CRON_SECRET = "short"
	await assert.rejects(configureScheduler(API_KEY), /strong CRON_SECRET/)
})

test("partial job listings fail before any writes", async () => {
	let calls = 0
	await assert.rejects(configureScheduler(API_KEY, {
		fetch: async () => { calls++; return Response.json({ jobs: [], someFailed: true }) },
	}), /incomplete job list/)
	assert.equal(calls, 1)
})

for (const kind of ["duplicate", "unmanaged", "invalid-id"]) {
	test(`conflicting ${kind} job refuses all writes`, async () => {
		const jobs = existingJobs()
		if (kind === "duplicate") jobs.push({ ...jobs[0], jobId: 90 })
		if (kind === "unmanaged") jobs[0].title = "created by someone else"
		if (kind === "invalid-id") jobs[0].jobId = "../other"
		const mock = provider(jobs)
		await assert.rejects(configureScheduler(API_KEY, mock.dependencies), /Conflicting jobs/)
		assert.deepEqual(mock.requests.map((r) => r.method), ["GET"])
	})
}

for (const httpStatus of [400, 401, 403, 429, 500]) {
	test(`provider HTTP ${httpStatus} bodies are never reflected`, async () => {
		await assert.rejects(configureScheduler(API_KEY, {
			fetch: async () => new Response(`${API_KEY} ${CRON_SECRET}`, { status: httpStatus }),
		}), (error: Error) => !error.message.includes(API_KEY) && !error.message.includes(CRON_SECRET))
		assert.equal(await db.collection<{ _id: string }>("setup_leases").countDocuments({}), 0)
	})
}

test("network exceptions cannot echo credentials", async () => {
	await assert.rejects(configureScheduler(API_KEY, {
		fetch: async () => { throw new Error(`${API_KEY} ${CRON_SECRET}`) },
	}), (error: Error & { cause?: unknown }) => !error.message.includes(API_KEY) && !error.cause)
})

test("oversized provider replies are bounded and redacted", async () => {
	await assert.rejects(configureScheduler(API_KEY, {
		fetch: async () => new Response(`{"s":"${"x".repeat(1024 * 1024)}"}`),
	}), /invalid response/)
})

test("a partial create can be resumed without duplicates", async () => {
	const mock = provider()
	const original = mock.dependencies.fetch
	let creates = 0
	await assert.rejects(configureScheduler(API_KEY, {
		...mock.dependencies,
		fetch: async (input, init) => {
			if (init?.method === "PUT" && ++creates === 3) return new Response("failed", { status: 500 })
			return original(input, init)
		},
	}))
	assert.equal(mock.jobs.length, 2)
	assert.equal((await schedulerStatus()).configured, false)
	const result = await configureScheduler(API_KEY, mock.dependencies)
	assert.equal(result.updated, 2)
	assert.equal(result.created, 6)
	assert.equal(mock.jobs.length, 8)
})

test("invalid returned job IDs cannot enter persistent state", async () => {
	await assert.rejects(configureScheduler(API_KEY, {
		fetch: async (_input, init) => Response.json(init?.method === "GET" ?
			{ jobs: [], someFailed: false } : { jobId: "../credential" }),
	}), /did not confirm the job ID/)
	assert.equal((await schedulerStatus()).configured, false)
})

test("setup API requires authentication", async () => {
	const response = await handleSchedulerSetup(request("POST", { apiKey: API_KEY }))
	assert.equal(response.status, 401)
})

for (const role of ["user", "admin"] as const) {
	test(`${role} API keys cannot configure or read scheduler state`, async () => {
		const user = await createUser({ username: role, role })
		const { key } = await createToken({ userId: user._id })
		for (const method of ["GET", "POST"]) {
			const response = await handleSchedulerSetup(request(method, method === "POST" ? { apiKey: API_KEY } : undefined,
				{ authorization: `Bearer ${key}` }))
			assert.equal(response.status, 403)
		}
	})
}

test("root sessions still require CSRF for scheduler writes", async () => {
	const user = await createUser({ username: "root", role: "root" })
	const session = await createSession(user)
	const response = await handleSchedulerSetup(request("POST", { apiKey: API_KEY }, {
		cookie: `${SESSION_COOKIE}=${session.token}`, origin: ORIGIN,
	}))
	assert.equal(response.status, 403)
})

test("root setup rejects unexpected callback hosts and secret fields", async () => {
	const user = await createUser({ username: "root", role: "root" })
	const { key } = await createToken({ userId: user._id })
	const response = await handleSchedulerSetup(request("POST", {
		apiKey: API_KEY, origin: "https://attacker.test", cronSecret: "attacker-supplied",
	}, { authorization: `Bearer ${key}` }))
	assert.equal(response.status, 400)
})

test("successful authenticated setup returns only safe metadata and audit counts", async () => {
	const user = await createUser({ username: "root", role: "root" })
	const session = await createSession(user)
	const mock = provider(existingJobs())
	globalThis.fetch = mock.dependencies.fetch
	const response = await handleSchedulerSetup(request("POST", { apiKey: API_KEY }, {
		cookie: `${SESSION_COOKIE}=${session.token}`, origin: ORIGIN, [CSRF_HEADER]: session.csrf,
	}))
	assert.equal(response.status, 200, await response.clone().text())
	const text = await response.text()
	assert.ok(!text.includes(API_KEY))
	assert.ok(!text.includes(CRON_SECRET))
	assert.equal(JSON.parse(text).updated, 8)
	const audits = await db.collection<{ _id: string; action: string }>("audit_logs").find({})
	assert.ok(audits.some((row) => row.action === "setup.cron-job-org"))
	assert.ok(!JSON.stringify(audits).includes(API_KEY))
	assert.ok(!JSON.stringify(audits).includes(CRON_SECRET))
})