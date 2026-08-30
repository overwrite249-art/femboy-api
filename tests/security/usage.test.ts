import test from "node:test"
import assert from "node:assert/strict"

import { setDb, usageLogs, usageRollups } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { redisCommand, setRedis } from "../../lib/redis/client.ts"
import { K } from "../../lib/redis/keys.ts"
import {
	buildUsageLog,
	flushUsageBuffer,
	hourBucket,
	pendingUsageCount,
	recordUsage,
} from "../../lib/usage/index.ts"
import type { UsageRecordInput } from "../../lib/usage/index.ts"

function fresh() {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
}

function input(overrides: Partial<UsageRecordInput> = {}): UsageRecordInput {
	return {
		requestId: "req-1",
		userId: "u1",
		tokenId: "t1",
		channelId: "c1",
		group: "default",
		model: "gpt-4o",
		mappedModel: "internal-4o",
		billedModel: "gpt-4o",
		endpoint: "/v1/chat/completions",
		dialect: "openai",
		stream: false,
		quota: 3750,
		elapsedMs: 1234,
		status: "success",
		httpStatus: 200,
		ipHash: "a".repeat(64),
		...overrides,
	}
}

test("the row is keyed on the request so it can only be charged once", () => {
	const doc = buildUsageLog(input())
	assert.equal(doc._id, "req-1")
	assert.equal(doc._id, doc.requestId)
})

test("a missing usage payload records zeros rather than NaN", () => {
	const doc = buildUsageLog(input({ quota: 0 }))
	assert.equal(doc.promptTokens, 0)
	assert.equal(doc.completionTokens, 0)
	assert.equal(doc.cachedTokens, 0)
	assert.equal(doc.reasoningTokens, 0)
	assert.equal(doc.firstByteMs, 0)
	assert.equal(doc.retries, 0)
	assert.deepEqual(doc.toolCalls, {})
	for (const value of Object.values(doc)) {
		assert.equal(Number.isNaN(value as number), false)
	}
})

test("the mapped and billed models are both recorded", () => {
	// GW-013: the audit trail has to show that what was billed is not what was
	// sent upstream, otherwise a mapping change is impossible to reconcile.
	const doc = buildUsageLog(input())
	assert.equal(doc.model, "gpt-4o")
	assert.equal(doc.mappedModel, "internal-4o")
	assert.equal(doc.billedModel, "gpt-4o")
})

test("no raw client address reaches the ledger", async () => {
	fresh()
	await recordUsage(input({ ipHash: "b".repeat(64) }), { buffered: false })
	const rows = await (await usageLogs()).find({})
	assert.equal(rows.length, 1)
	// GW-024: only the HMAC is persisted, and nothing that looks like an address.
	const serialised = JSON.stringify(rows[0])
	assert.equal(/\b\d{1,3}(\.\d{1,3}){3}\b/.test(serialised), false)
	assert.equal(rows[0].ipHash, "b".repeat(64))
})

test("buffered writes land in redis and only reach mongo on flush", async () => {
	fresh()
	await recordUsage(input())
	assert.equal(await pendingUsageCount(), 1)
	assert.equal((await (await usageLogs()).find({})).length, 0)

	assert.equal(await flushUsageBuffer(), 1)
	assert.equal(await pendingUsageCount(), 0)
	assert.equal((await (await usageLogs()).find({})).length, 1)
})

test("a replayed flush does not bill twice", async () => {
	fresh()
	// The same request buffered twice, as a crash between pop and write would
	// produce.
	await recordUsage(input({ requestId: "req-dup", quota: 100 }))
	await recordUsage(input({ requestId: "req-dup", quota: 100 }))
	assert.equal(await pendingUsageCount(), 2)

	await flushUsageBuffer()
	const rows = await (await usageLogs()).find({})
	assert.equal(rows.length, 1, "the request id must collapse duplicates")
	assert.equal(rows[0].quota, 100)
})

test("an empty buffer flushes to nothing", async () => {
	fresh()
	assert.equal(await flushUsageBuffer(), 0)
})

test("a corrupt buffer entry does not stall the drain", async () => {
	fresh()
	await redisCommand(["RPUSH", K.usageBuffer(), "{not json"])
	await recordUsage(input({ requestId: "req-good" }))
	assert.equal(await flushUsageBuffer(), 1)
	const rows = await (await usageLogs()).find({})
	assert.equal(rows.length, 1)
	assert.equal(rows[0]._id, "req-good")
})

test("rollups accumulate per user, channel, model and globally", async () => {
	fresh()
	await recordUsage(input({ requestId: "r1", quota: 100 }), { buffered: false })
	await recordUsage(input({ requestId: "r2", quota: 250 }), { buffered: false })
	await recordUsage(
		input({ requestId: "r3", quota: 0, status: "error", httpStatus: 500 }),
		{ buffered: false },
	)

	const bucket = hourBucket()
	const global = await (await usageRollups()).findOne({ _id: `global:all:${bucket}` })
	assert.equal(global?.requests, 3)
	assert.equal(global?.quota, 350)
	assert.equal(global?.errors, 1)

	const user = await (await usageRollups()).findOne({ _id: `user:u1:${bucket}` })
	assert.equal(user?.requests, 3)
	assert.equal(user?.quota, 350)

	// The rollup is keyed on the billed model, not the upstream one.
	const model = await (await usageRollups()).findOne({ _id: `model:gpt-4o:${bucket}` })
	assert.equal(model?.requests, 3)
})

test("an aborted request is still recorded", async () => {
	fresh()
	// Otherwise a client that hangs up mid-stream leaves no trace of the work
	// the upstream already did and was already charged for (GW-009).
	await recordUsage(
		input({ requestId: "r-abort", status: "aborted", httpStatus: 499, quota: 42 }),
		{ buffered: false },
	)
	const rows = await (await usageLogs()).find({})
	assert.equal(rows.length, 1)
	assert.equal(rows[0].status, "aborted")
	assert.equal(rows[0].quota, 42)
})

test("hour buckets are stable and hourly", () => {
	assert.equal(hourBucket(new Date("2026-08-30T21:14:59.999Z")), "2026-08-30T21")
	assert.equal(hourBucket(new Date("2026-08-30T21:00:00.000Z")), "2026-08-30T21")
	assert.notEqual(
		hourBucket(new Date("2026-08-30T21:59:59Z")),
		hourBucket(new Date("2026-08-30T22:00:00Z")),
	)
})
