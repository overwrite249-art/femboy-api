import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { setDb } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MongoCoordinator, COORDINATION_KEYS, COORDINATION_ITEMS } from "../../lib/redis/mongo.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { getRedis, setRedis, runScript, isDegraded, redisCommand } from "../../lib/redis/client.ts"
import { assertProductionReady, validateConfig } from "../../lib/config/env.ts"
import { SCRIPTS } from "../../lib/redis/lua.ts"
import { runScriptTwin } from "../../lib/redis/scripts.ts"

const environment = { ...process.env }
const originalNow = Date.now
let db: MemoryDatabase
let first: MongoCoordinator
let second: MongoCoordinator

beforeEach(() => {
	Object.assign(process.env, { NODE_ENV: "test" })
	delete process.env.COORDINATION_BACKEND
	delete process.env.UPSTASH_REDIS_REST_URL
	delete process.env.UPSTASH_REDIS_REST_TOKEN
	delete process.env.MONGODB_URI
	db = new MemoryDatabase()
	setDb(db)
	first = new MongoCoordinator()
	second = new MongoCoordinator()
	setRedis(first)
})
afterEach(() => {
	setDb(null)
	setRedis(null)
	Date.now = originalNow
	for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
	Object.assign(process.env, environment)
})

test("independent coordinator instances share durable values and counters", async () => {
	await first.command(["SET", "shared", "42"])
	assert.equal(await second.command(["GET", "shared"]), "42")
	await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? first : second).command(["INCR", "counter"])))
	assert.equal(await new MongoCoordinator().command(["GET", "counter"]), "40")
})

test("concurrent SET NX has exactly one winner across instances", async () => {
	const values = await Promise.all(Array.from({ length: 30 }, (_, i) =>
		(i % 2 ? first : second).command(["SET", "lock", `owner-${i}`, "EX", 30, "NX"])))
	assert.equal(values.filter((value) => value === "OK").length, 1)
})

test("expiry is enforced before MongoDB TTL cleanup, including queue items", async () => {
	let now = 100_000
	Date.now = () => now
	await first.command(["SET", "key", "expired", "EX", 10])
	await first.command(["RPUSH", "queue", "expired"])
	await first.command(["EXPIRE", "queue", 10])
	now += 10_001
	assert.equal(await second.command(["GET", "key"]), null)
	assert.equal(await second.command(["LLEN", "queue"]), 0)
	assert.equal(await db.collection<{ _id: string }>(COORDINATION_ITEMS).countDocuments({}), 0)
	assert.equal(await first.command(["SET", "key", "new", "NX"]), "OK")
})

test("owner-checked lock release cannot delete a newer owner", async () => {
	await first.command(["SET", "lease", "new-owner", "EX", 60])
	assert.deepEqual(await second.runScript("releaseLock", ["lease"], ["old-owner"]), [0])
	assert.equal(await first.command(["GET", "lease"]), "new-owner")
	assert.deepEqual(await second.runScript("releaseLock", ["lease"], ["new-owner"]), [1])
})

test("atomic fixed windows reject oversubscription across instances", async () => {
	const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
		(i % 2 ? first : second).runScript("fixedWindow", ["attempts"], [5, 60, 1])))
	assert.equal(results.filter(([allowed]) => allowed === 1).length, 5)
	assert.equal(await first.command(["GET", "attempts"]), "5")
})

test("atomic token buckets reject oversubscription across instances", async () => {
	const now = Date.now()
	const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
		(i % 2 ? first : second).runScript("tokenBucket", ["rpm"], [5, 0, now, 1, 60])))
	assert.equal(results.filter(([allowed]) => allowed === 1).length, 5)
})

test("concurrency slots use distinct owners and survive coordinator restarts", async () => {
	const now = Date.now()
	const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
		(i % 2 ? first : second).runScript("concurrency", ["slots"], [3, now, 30_000, `request-${i}`])))
	assert.equal(results.filter(([allowed]) => allowed === 1).length, 3)
	assert.equal(await new MongoCoordinator().command(["ZCARD", "slots"]), 3)
	assert.deepEqual(await first.runScript("concurrency", ["slots"], [3, now + 30_001, 30_000, "later"]), [1, 1])
})

test("list items are separate documents, preserving FIFO under concurrent appends", async () => {
	await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? first : second).command(["RPUSH", "queue", String(i)])))
	assert.equal(await first.command(["LLEN", "queue"]), 25)
	const values = await second.command(["LRANGE", "queue", 0, -1]) as string[]
	assert.equal(new Set(values).size, 25)
	assert.equal(await db.collection<{ _id: string }>(COORDINATION_ITEMS).countDocuments({ key: "queue" }), 25)
	const metadata = await db.collection<{ _id: string; snapshot?: unknown }>(COORDINATION_KEYS).findOne({ _id: "queue" })
	assert.equal(metadata?.snapshot, undefined)
	assert.deepEqual(await new MongoCoordinator().command(["LPOP", "queue", 25]), values)
	assert.equal(await first.command(["LLEN", "queue"]), 0)
})

test("list trims and negative indices preserve exact remaining records", async () => {
	await first.command(["RPUSH", "list", "a", "b", "c", "d", "e"])
	assert.deepEqual(await second.command(["LRANGE", "list", -3, -1]), ["c", "d", "e"])
	assert.equal(await second.command(["LTRIM", "list", 1, -2]), "OK")
	assert.deepEqual(await first.command(["LRANGE", "list", 0, -1]), ["b", "c", "d"])
	await first.command(["LPUSH", "list", "one", "two"])
	assert.deepEqual(await first.command(["LRANGE", "list", 0, 2]), ["two", "one", "b"])
	await first.command(["LTRIM", "list", 100, -1])
	assert.equal(await first.command(["EXISTS", "list"]), 0)
})

test("SET over a list preserves XX/NX semantics and cleans old items", async () => {
	await first.command(["RPUSH", "list", "a", "b"])
	assert.equal(await first.command(["SET", "list", "x", "NX"]), null)
	assert.equal(await first.command(["SET", "list", "x", "XX"]), "OK")
	assert.equal(await second.command(["GET", "list"]), "x")
	assert.equal(await db.collection<{ _id: string }>(COORDINATION_ITEMS).countDocuments({ key: "list" }), 0)
})

test("queue acknowledgement removes only the observed prefix and respects ownership", async () => {
	await first.command(["RPUSH", "usage", "a", "b"])
	await first.command(["SET", "lease", "owner", "EX", 60])
	const observed = await first.command(["LRANGE", "usage", 0, 1])
	assert.deepEqual(observed, ["a", "b"])
	await second.command(["RPUSH", "usage", "c"])
	assert.deepEqual(await second.runScript("ackUsage", ["usage", "lease"], ["wrong", 2]), [0])
	assert.deepEqual(await first.runScript("ackUsage", ["usage", "lease"], ["owner", 2]), [1])
	assert.deepEqual(await second.command(["LRANGE", "usage", 0, -1]), ["c"])
})

test("failed pipelines roll back earlier writes and queue inserts", async () => {
	await assert.rejects(first.pipeline([
		["SET", "transaction-key", "a"], ["RPUSH", "transaction-list", "value"], ["UNSUPPORTED", "x"],
	]))
	assert.equal(await second.command(["GET", "transaction-key"]), null)
	assert.equal(await second.command(["LLEN", "transaction-list"]), 0)
})

test("unsupported scripts and arbitrary EVAL are refused", async () => {
	await assert.rejects(first.command(["EVAL", "return 1", 0]), /unsupported/)
	await assert.rejects(first.runScript("missing" as keyof typeof SCRIPTS, [], []), /unknown script/)
})

test("oversized values and unbounded queue reads fail without partial writes", async () => {
	await assert.rejects(first.command(["SET", "too-large", "x".repeat(1024 * 1024)]), /safe size/)
	assert.equal(await first.command(["GET", "too-large"]), null)
	await first.command(["RPUSH", "many", ...Array(1001).fill("v")])
	await assert.rejects(first.command(["LRANGE", "many", 0, -1]), /safe limit/)
	assert.equal(await first.command(["LLEN", "many"]), 1001)
})

test("Mongo-backed named programs match the reference interpreter", async () => {
	const twin = new MemoryRedis()
	const commands = [
		["SET", "user", 1000], ["SET", "token", 1000],
	] as Array<Array<string | number>>
	for (const command of commands) assert.deepEqual(await first.command(command), await twin.command(command))
	const programs = [
		["reserve", ["user", "token", "reservation"], [100, 60, "rid", 0]],
		["settle", ["user", "token", "reservation", "journal"], [30, "rid", "uid", "tid", 3600]],
		["reserve", ["user", "", "reservation2"], [50, 60, "rid2", 0]],
		["release", ["user", "", "reservation2", "journal"], ["rid2", "uid", "", 3600]],
		["health", ["health"], [0, 2, 60, 1000]],
		["health", ["health"], [0, 2, 60, 1000]],
		["nextKey", ["key-cursor"], [3]],
		["slidingSuccess", ["success"], [3, 60_000, 1000, "one"]],
	] as Array<[keyof typeof SCRIPTS, string[], Array<string | number>]>
	for (const [name, keys, args] of programs) {
		assert.deepEqual(await first.runScript(name, keys, args), await runScriptTwin(twin, name, keys, args), name)
	}
	assert.equal(await first.command(["GET", "user"]), "970")
})

test("storage failures mark coordination degraded and never fall back to local state", async () => {
	db.transaction = async () => { throw new Error("injected offline database") }
	await assert.rejects(runScript("fixedWindow", ["login"], [5, 60, 1]))
	assert.equal(isDegraded(), true)
	await assert.rejects(redisCommand(["SET", "cannot-persist", "x"]))
	assert.equal(getRedis().kind, "mongo")
})

test("production accepts MongoDB-only configuration and refuses in-memory storage", async () => {
	Object.assign(process.env, {
		NODE_ENV: "production", MONGODB_URI: "mongodb://127.0.0.1:27017/fixture",
		KEY_PEPPER: "a".repeat(64), CHANNEL_KEY_MASTER: "b".repeat(64),
		SESSION_SECRET: "c".repeat(64), CRON_SECRET: "d".repeat(64), IP_HASH_SECRET: "e".repeat(64),
		COORDINATION_BACKEND: "mongo",
	})
	assert.deepEqual(validateConfig(), [])
	assert.doesNotThrow(assertProductionReady)
	setRedis(null)
	assert.equal(getRedis().kind, "mongo")
	await assert.rejects(redisCommand(["SET", "key", "value"]), /durable MongoDB/)
})

test("auto selects MongoDB when configured and partial Upstash never silently falls back", () => {
	process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/fixture"
	setRedis(null)
	assert.equal(getRedis().kind, "mongo")
	process.env.UPSTASH_REDIS_REST_URL = "https://fixture.upstash.io"
	setRedis(null)
	assert.throws(getRedis, /both Upstash/)
	process.env.COORDINATION_BACKEND = "mongo"
	assert.equal(getRedis().kind, "mongo")
})