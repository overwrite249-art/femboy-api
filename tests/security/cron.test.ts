process.env.CRON_SECRET = "cron-secret-value-for-tests"

import test from "node:test"
import assert from "node:assert/strict"

import { assertCronAuthorized, runCronJob } from "../../lib/cron/guard.ts"
import { expireTokens, reconcileQuota } from "../../lib/cron/jobs.ts"
import { setDb, tokens, usageRollups, users } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"

const SECRET = "cron-secret-value-for-tests"

function cronRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://gateway.test/api/cron/flush-usage", { method: "GET", headers })
}

test("a cron request without the secret is refused", async () => {
	await assert.rejects(assertCronAuthorized(cronRequest()), /cron authorization failed/i)
})

test("a wrong secret is refused", async () => {
	await assert.rejects(
		assertCronAuthorized(cronRequest({ authorization: "Bearer not-the-secret" })),
		/cron authorization failed/i,
	)
})

test("a nearly-correct secret is still refused", async () => {
	// One byte short. A prefix compare would accept this.
	await assert.rejects(
		assertCronAuthorized(cronRequest({ authorization: `Bearer ${SECRET.slice(0, -1)}` })),
		/cron authorization failed/i,
	)
})

test("Vercel's own cron header is not a credential", async () => {
	// Any client can send this header, so it must carry no authority at all.
	await assert.rejects(
		assertCronAuthorized(cronRequest({ "x-vercel-cron": "1" })),
		/cron authorization failed/i,
	)
})

test("either credential form is accepted", async () => {
	await assertCronAuthorized(cronRequest({ authorization: `Bearer ${SECRET}` }))
	await assertCronAuthorized(cronRequest({ "x-cron-secret": SECRET }))
})

test("an unconfigured secret fails closed rather than open", async () => {
	const previous = process.env.CRON_SECRET
	process.env.CRON_SECRET = ""
	try {
		await assert.rejects(
			assertCronAuthorized(cronRequest({ authorization: "Bearer anything" })),
			/not configured/i,
		)
	} finally {
		process.env.CRON_SECRET = previous
	}
})

test("runCronJob reports failures without running the job", async () => {
	let ran = false
	const response = await runCronJob(cronRequest(), "flush-usage", async () => {
		ran = true
		return {}
	})
	assert.equal(response.status, 403)
	assert.equal(ran, false)
})

test("runCronJob runs an authorised job and reports its result", async () => {
	const response = await runCronJob(
		cronRequest({ authorization: `Bearer ${SECRET}` }),
		"flush-usage",
		async () => ({ flushed: 7 }),
	)
	assert.equal(response.status, 200)
	const body = (await response.json()) as Record<string, unknown>
	assert.equal(body.ok, true)
	assert.equal(body.job, "flush-usage")
	assert.equal(body.flushed, 7)
})

test("expired tokens are disabled and live ones are left alone", async () => {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())

	const collection = await tokens()
	const base = {
		userId: "u1",
		name: "k",
		keyPrefix: "sk-aaaaaaa",
		keyDigest: "d",
		keyLast4: "1234",
		status: "enabled" as const,
		quota: 0,
		usedQuota: 0,
		unlimitedQuota: true,
		allowedIps: [],
		allowedModels: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	}
	await collection.insertOne({ ...base, _id: "past", expiresAt: new Date(Date.now() - 60_000) })
	await collection.insertOne({ ...base, _id: "future", expiresAt: new Date(Date.now() + 60_000) })
	await collection.insertOne({ ...base, _id: "never", expiresAt: null })

	const result = await expireTokens()
	assert.equal(result.expired, 1)
	assert.equal((await collection.findOne({ _id: "past" }))?.status, "disabled")
	assert.equal((await collection.findOne({ _id: "future" }))?.status, "enabled")
	assert.equal((await collection.findOne({ _id: "never" }))?.status, "enabled")
})

test("reconciliation corrects a drifted spend counter from the ledger", async () => {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())

	await (await users()).insertOne({
		_id: "u1",
		username: "u",
		displayName: "U",
		email: "u@example.com",
		role: "user",
		status: "enabled",
		group: "default",
		quota: 10_000,
		// Wrong on purpose: a crash between the ledger write and this counter.
		usedQuota: 999,
		requestCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	})

	const rollups = await usageRollups()
	await rollups.insertOne({
		_id: "user:u1:2026-08-30T10",
		scope: "user",
		key: "u1",
		bucket: "2026-08-30T10",
		requests: 2,
		errors: 0,
		quota: 300,
		promptTokens: 10,
		completionTokens: 20,
		updatedAt: new Date(),
	})
	await rollups.insertOne({
		_id: "user:u1:2026-08-30T11",
		scope: "user",
		key: "u1",
		bucket: "2026-08-30T11",
		requests: 1,
		errors: 1,
		quota: 200,
		promptTokens: 5,
		completionTokens: 5,
		updatedAt: new Date(),
	})

	const result = await reconcileQuota()
	assert.equal(result.corrected, 1)
	// The ledger says 500, so the counter must now say 500.
	assert.equal((await (await users()).findOne({ _id: "u1" }))?.usedQuota, 500)

	// Running it again is a no-op: reconciliation must be idempotent.
	assert.equal((await reconcileQuota()).corrected, 0)
})
