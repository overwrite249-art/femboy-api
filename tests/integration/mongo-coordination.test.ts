import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { connectMongo, closeMongo } from "../../lib/db/mongo.ts"
import { setDb } from "../../lib/db/index.ts"
import { MongoCoordinator, COORDINATION_ITEMS } from "../../lib/redis/mongo.ts"

const uri = process.env.MONGODB_TEST_URI
test("real MongoDB-only coordination invariants", { skip: !uri }, async (t) => {
	assert.match(uri!, /^mongodb:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//, "integration tests are loopback-only")
	const databaseName = `fbapi_coordination_test_${randomUUID().replace(/-/g, "")}`
	Object.assign(process.env, { NODE_ENV: "test", MONGODB_URI: uri, MONGODB_DB: databaseName })
	const db = await connectMongo()
	setDb(db)
	const clients = Array.from({ length: 4 }, () => new MongoCoordinator())
	try {
		await t.test("concurrent first-key creation and increments do not lose updates", async () => {
			await Promise.all(Array.from({ length: 20 }, (_, i) => clients[i % 4].command(["INCR", "counter"])))
			assert.equal(await new MongoCoordinator().command(["GET", "counter"]), "20")
		})
		await t.test("only one Mongo-backed lock owner wins", async () => {
			const outcomes = await Promise.all(Array.from({ length: 16 }, (_, i) =>
				clients[i % 4].command(["SET", "lease", `owner-${i}`, "NX", "EX", 60])))
			assert.equal(outcomes.filter((value) => value === "OK").length, 1)
		})
		await t.test("first-request fixed-window races cannot oversubscribe", async () => {
			const outcomes = await Promise.all(Array.from({ length: 16 }, (_, i) =>
				clients[i % 4].runScript("fixedWindow", ["window"], [4, 60, 1])))
			assert.equal(outcomes.filter(([allowed]) => allowed === 1).length, 4)
		})
		await t.test("concurrency programs commit atomically across instances", async () => {
			const now = Date.now()
			const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
				clients[i % 4].runScript("concurrency", ["slots"], [3, now, 30_000, `request-${i}`])))
			assert.equal(outcomes.filter(([allowed]) => allowed === 1).length, 3)
		})
		await t.test("queue appends and owner-checked acknowledgement survive restarts", async () => {
			await Promise.all(Array.from({ length: 12 }, (_, i) => clients[i % 4].command(["RPUSH", "usage", `row-${i}`])))
			const reader = new MongoCoordinator()
			const values = await reader.command(["LRANGE", "usage", 0, -1]) as string[]
			assert.equal(new Set(values).size, 12)
			assert.equal(await db.collection<{ _id: string }>(COORDINATION_ITEMS).countDocuments({ key: "usage" }), 12)
			await reader.command(["SET", "ack-lease", "owner", "EX", 60])
			await reader.runScript("ackUsage", ["usage", "ack-lease"], ["owner", 5])
			assert.deepEqual(await new MongoCoordinator().command(["LRANGE", "usage", 0, -1]), values.slice(5))
		})
		await t.test("failed queue mutations roll back rather than claiming success", async () => {
			await assert.rejects(clients[0].pipeline([["RPUSH", "rollback", "never-commit"], ["BAD", "key"]]))
			assert.equal(await clients[1].command(["LLEN", "rollback"]), 0)
		})
		await t.test("expiry is enforced without waiting for TTL monitor", async () => {
			await clients[0].command(["SET", "expired", "value", "PX", 1])
			await new Promise((resolve) => setTimeout(resolve, 5))
			assert.equal(await clients[1].command(["GET", "expired"]), null)
		})
	} finally {
		setDb(null)
		await closeMongo()
		const cleanup = new MongoClient(uri!)
		try { await cleanup.db(databaseName).dropDatabase() } finally { await cleanup.close() }
	}
})