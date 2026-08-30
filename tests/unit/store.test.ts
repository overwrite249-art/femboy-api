import test from "node:test"
import assert from "node:assert/strict"

import { MemoryDatabase } from "../../lib/db/memory.ts"
import { DuplicateKeyError } from "../../lib/db/driver.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis, runScript, redisGet } from "../../lib/redis/client.ts"
import { K } from "../../lib/redis/keys.ts"
import {
	base64UrlDecode,
	base64UrlEncode,
	hmacSha256Hex,
	openSecret,
	randomAlphanumeric,
	sealSecret,
	sha256Hex,
	signToken,
	timingSafeEqualHex,
	verifyToken,
} from "../../lib/util/crypto.ts"
import { assertJsonLimits, JsonLimitError, safeJsonParse } from "../../lib/util/json.ts"
import { isRetryableStatus } from "../../lib/http/errors.ts"

type Row = { _id: string; name?: string; quota?: number; tags?: string[]; nested?: { a?: number } }

test("memory store: crud, operators, sorting and projection", async () => {
	const db = new MemoryDatabase()
	const col = db.collection<Row>("rows")
	await col.insertOne({ _id: "a", name: "alpha", quota: 10, tags: ["x"] })
	await col.insertOne({ _id: "b", name: "beta", quota: 30, tags: ["x", "y"] })
	await col.insertOne({ _id: "c", name: "gamma", quota: 20 })

	assert.equal(await col.countDocuments({}), 3)
	assert.equal((await col.find({ quota: { $gte: 20 } })).length, 2)
	assert.equal((await col.find({ tags: "y" })).length, 1)
	assert.equal((await col.find({ tags: { $in: ["x"] } })).length, 2)
	assert.equal((await col.find({ quota: { $exists: true } })).length, 3)
	assert.equal((await col.find({ $or: [{ name: "alpha" }, { name: "gamma" }] })).length, 2)

	const sorted = await col.find({}, { sort: { quota: -1 }, limit: 2 })
	assert.deepEqual(sorted.map((r) => r._id), ["b", "c"])

	const projected = await col.findOne({ _id: "a" }, { projection: { name: 1 } })
	assert.deepEqual(projected, { _id: "a", name: "alpha" })
})

test("memory store: update operators", async () => {
	const db = new MemoryDatabase()
	const col = db.collection<Row>("rows")
	await col.insertOne({ _id: "a", quota: 10, tags: [] })

	await col.updateOne({ _id: "a" }, { $inc: { quota: -3 } })
	assert.equal((await col.findOne({ _id: "a" }))?.quota, 7)

	await col.updateOne({ _id: "a" }, { $addToSet: { tags: "x" } })
	await col.updateOne({ _id: "a" }, { $addToSet: { tags: "x" } })
	assert.deepEqual((await col.findOne({ _id: "a" }))?.tags, ["x"])

	await col.updateOne({ _id: "a" }, { $set: { "nested.a": 5 } })
	assert.equal((await col.findOne({ _id: "a" }))?.nested?.a, 5)

	await col.updateOne({ _id: "z" }, { $set: { name: "upserted" } }, true)
	assert.equal((await col.findOne({ _id: "z" }))?.name, "upserted")
})

test("memory store: guarded findOneAndUpdate is a compare-and-swap", async () => {
	const db = new MemoryDatabase()
	const col = db.collection<Row>("rows")
	await col.insertOne({ _id: "a", quota: 100 })

	const ok = await col.findOneAndUpdate({ _id: "a", quota: { $gte: 60 } }, { $inc: { quota: -60 } })
	assert.equal(ok?.quota, 40)

	const denied = await col.findOneAndUpdate({ _id: "a", quota: { $gte: 60 } }, { $inc: { quota: -60 } })
	assert.equal(denied, null)
	assert.equal((await col.findOne({ _id: "a" }))?.quota, 40)
})

test("memory store: unique indexes are enforced", async () => {
	const db = new MemoryDatabase()
	const col = db.collection<{ _id: string; digest: string }>("keys")
	await col.createIndexes([{ key: { digest: 1 }, name: "uniq_digest", unique: true }])
	await col.insertOne({ _id: "1", digest: "abc" })
	await assert.rejects(() => col.insertOne({ _id: "2", digest: "abc" }), DuplicateKeyError)
	await col.insertOne({ _id: "3", digest: "def" })
	assert.equal(await col.countDocuments({}), 2)
})

test("crypto: digest, hmac, sealing and tokens", async () => {
	assert.equal(
		await sha256Hex("abc"),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	)
	assert.equal(
		await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"),
		"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
	)

	assert.ok(timingSafeEqualHex("deadbeef", "deadbeef"))
	assert.ok(!timingSafeEqualHex("deadbeef", "deadbeee"))
	assert.ok(!timingSafeEqualHex("deadbeef", "deadbee"))

	const master = "m".repeat(48)
	const sealed = await sealSecret("sk-upstream-secret-value", master, 1)
	assert.notEqual(sealed.cipher, "sk-upstream-secret-value")
	assert.equal(await openSecret(sealed, master), "sk-upstream-secret-value")
	await assert.rejects(() => openSecret(sealed, "w".repeat(48)))

	const round = base64UrlDecode(base64UrlEncode(new TextEncoder().encode("hello?/+")))
	assert.equal(new TextDecoder().decode(round), "hello?/+")

	const secret = "s".repeat(40)
	const signed = await signToken({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 60 }, secret)
	assert.equal((await verifyToken(signed, secret))?.sub, "u1")
	assert.equal(await verifyToken(signed, "other"), null)
	const expired = await signToken({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 5 }, secret)
	assert.equal(await verifyToken(expired, secret), null)

	const rnd = randomAlphanumeric(48)
	assert.equal(rnd.length, 48)
	assert.match(rnd, /^[A-Za-z0-9]+$/)
})

test("json: prototype pollution and depth limits", () => {
	const parsed = safeJsonParse<Record<string, unknown>>('{"a":1,"__proto__":{"polluted":true}}')
	assert.equal(parsed.a, 1)
	assert.equal((parsed as { __proto__?: unknown }).__proto__ !== undefined, true)
	assert.equal(({} as Record<string, unknown>).polluted, undefined)
	assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined)

	let deep = "{}"
	for (let i = 0; i < 200; i++) deep = `{"a":${deep}}`
	assert.throws(() => safeJsonParse(deep, { maxDepth: 64 }), JsonLimitError)
	assert.throws(() => safeJsonParse('{"a":1}', { maxBytes: 3 }), JsonLimitError)
	assert.doesNotThrow(() => assertJsonLimits({ a: { b: { c: 1 } } }, { maxDepth: 8 }))
})

test("retry matrix follows the specification", () => {
	for (const status of [200, 201, 400, 408, 504, 524]) {
		assert.equal(isRetryableStatus(status), false, `${status} must not retry`)
	}
	for (const status of [401, 403, 404, 409, 429, 500, 502, 503, 520, 529]) {
		assert.equal(isRetryableStatus(status), true, `${status} must retry`)
	}
})

test("redis twin: quota reserve/settle is atomic and idempotent", async () => {
	const redis = new MemoryRedis()
	setRedis(redis)
	const userKey = K.userQuota("u1")
	await redis.command(["SET", userKey, "1000"])

	const first = await runScript("reserve", [userKey, "", K.reservation("r1")], [600, 60, "r1", 0])
	assert.deepEqual(first.slice(0, 2), [1, 400])

	// Second concurrent reservation must be refused: 400 remaining < 600.
	const second = await runScript("reserve", [userKey, "", K.reservation("r2")], [600, 60, "r2", 0])
	assert.equal(second[0], 0)
	assert.equal(await redisGet(userKey), "400")

	// Replaying the same reservation id is a no-op.
	const replay = await runScript("reserve", [userKey, "", K.reservation("r1")], [600, 60, "r1", 0])
	assert.equal(replay[0], 2)
	assert.equal(await redisGet(userKey), "400")

	// Settle for less than reserved refunds the difference.
	const settled = await runScript(
		"settle",
		[userKey, "", K.reservation("r1"), K.quotaJournal()],
		[150, "r1", "u1", "t1", 3600],
	)
	assert.equal(settled[0], 1)
	assert.equal(await redisGet(userKey), "850")

	// Settling twice must not move the balance again (GW-009).
	const resettled = await runScript(
		"settle",
		[userKey, "", K.reservation("r1"), K.quotaJournal()],
		[150, "r1", "u1", "t1", 3600],
	)
	assert.equal(resettled[0], 2)
	assert.equal(await redisGet(userKey), "850")
	setRedis(null)
})

test("redis twin: release refunds an abandoned reservation", async () => {
	const redis = new MemoryRedis()
	setRedis(redis)
	const userKey = K.userQuota("u2")
	await redis.command(["SET", userKey, "500"])
	await runScript("reserve", [userKey, "", K.reservation("r9")], [200, 60, "r9", 0])
	assert.equal(await redisGet(userKey), "300")
	const released = await runScript(
		"release",
		[userKey, "", K.reservation("r9"), K.quotaJournal()],
		["r9", "u2", "t2", 3600],
	)
	assert.deepEqual(released, [1, 200])
	assert.equal(await redisGet(userKey), "500")
	setRedis(null)
})

test("redis twin: limiter scripts", async () => {
	setRedis(new MemoryRedis())
	const bucket = K.rpm("user", "u1")
	const now = Date.now()
	let allowed = 0
	for (let i = 0; i < 5; i++) {
		const [ok] = await runScript("tokenBucket", [bucket], [3, 1, now, 1, 60])
		allowed += ok
	}
	assert.equal(allowed, 3, "bucket capacity must be a hard ceiling")

	const window = K.tpm("user", "u1")
	assert.deepEqual((await runScript("fixedWindow", [window], [10, 60, 4])).slice(0, 2), [1, 4])
	assert.equal((await runScript("fixedWindow", [window], [10, 60, 7]))[0], 0)
	assert.equal((await runScript("fixedWindow", [window], [10, 60, 6]))[0], 1)

	const succ = K.successWindow("u1")
	for (let i = 0; i < 3; i++) {
		assert.equal((await runScript("slidingSuccess", [succ], [3, 1000, Date.now(), `m${i}`]))[0], 1)
	}
	assert.equal((await runScript("slidingSuccess", [succ], [3, 1000, Date.now(), "m4"]))[0], 0)
	setRedis(null)
})

test("redis twin: circuit breaker trips and resets", async () => {
	setRedis(new MemoryRedis())
	const key = K.channelHealth("ch1")
	assert.deepEqual(await runScript("health", [key], [0, 3, 60, Date.now()]), [0, 1])
	assert.deepEqual(await runScript("health", [key], [0, 3, 60, Date.now()]), [0, 2])
	assert.deepEqual(await runScript("health", [key], [0, 3, 60, Date.now()]), [1, 3])
	assert.deepEqual(await runScript("health", [key], [1, 3, 60, Date.now()]), [0, 0])
	setRedis(null)
})
