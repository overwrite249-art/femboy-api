/**
 * Real transaction tests, never a production target.
 * CI starts a disposable replica set and supplies MONGODB_TEST_URI.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { connectMongo, closeMongo } from "../../lib/db/mongo.ts"
import { setDb, users, usageRollups } from "../../lib/db/index.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis, redisCommand } from "../../lib/redis/client.ts"
import { K } from "../../lib/redis/keys.ts"
import { createUser, createToken } from "../../lib/admin/store.ts"
import { authenticate } from "../../lib/auth/authenticate.ts"
import { createRedemptionBatch, redeemCode } from "../../lib/admin/catalog.ts"
import { reserveQuota, settleQuota, currentBalance, finalizeQuota, flushQuotaSettlements } from "../../lib/quota/index.ts"
import { recordUsage, hourBucket } from "../../lib/usage/index.ts"

const uri = process.env.MONGODB_TEST_URI
test("MongoDB replica-set accounting invariants", { skip: !uri }, async (t) => {
	assert.match(uri!, /^mongodb:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//, "integration tests are loopback-only")
	const databaseName = `fbapi_test_${randomUUID().replace(/-/g, "")}`
	Object.assign(process.env, { NODE_ENV: "test" })
	process.env.MONGODB_URI = uri
	process.env.MONGODB_DB = databaseName
	process.env.KEY_PEPPER = "integration-pepper-fixture"
	process.env.IP_HASH_SECRET = "integration-ip-fixture"
	process.env.MIN_AUTH_LATENCY_MS = "0"
	setRedis(new MemoryRedis())
	const db = await connectMongo()
	setDb(db)

	async function account(username: string, quota = 1000) {
		const user = await createUser({ username, quota })
		const { key } = await createToken({ userId: user._id, quota, unlimitedQuota: false })
		return (await authenticate(new Request("https://gateway.test/v1/models", {
			headers: { authorization: `Bearer ${key}` },
		}))).identity
	}
	try {
		await t.test("concurrent reservations cannot oversell durable user and token balances", async () => {
			const who = await account("race")
			const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reserveQuota(who, `race-${i}`, 200)))
			assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 5)
			assert.equal(await currentBalance(who), 0)
		})
		await t.test("rollback restores every document touched by a failed transaction", async () => {
			const who = await account("rollback")
			await assert.rejects(db.transaction(async (tx) => {
				await tx.collection("users").updateOne({ _id: who.userId }, { $inc: { quota: -100 } })
				await tx.collection("tokens").updateOne({ _id: who.tokenId }, { $inc: { quota: -100 } })
				throw new Error("injected transaction failure")
			}), /injected/)
			assert.equal(await currentBalance(who), 1000)
		})
		await t.test("simultaneous settlement replays charge only once", async () => {
			const who = await account("settle")
			await reserveQuota(who, "settle-replay", 500)
			const outcomes = await Promise.all(Array.from({ length: 8 }, () => settleQuota(who, "settle-replay", 150)))
			assert.equal(outcomes.filter((outcome) => outcome.applied).length, 1)
			assert.equal(await currentBalance(who), 850)
			assert.equal((await (await users()).findOne({ _id: who.userId }))?.usedQuota, 150)
		})
		await t.test("redemption claim and credit commit exactly once", async () => {
			const who = await account("redeem")
			const batch = await createRedemptionBatch({ count: 1, quota: 42, createdBy: "fixture-root" })
			const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => redeemCode(batch.codes[0], who.userId)))
			assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
			assert.equal(await currentBalance(who), 1042)
		})
		await t.test("duplicate usage deliveries cannot increment derived rollups again", async () => {
			const input = {
				requestId: "duplicate-usage", userId: "usage-user", tokenId: "usage-token", channelId: "channel",
				group: "default", model: "fixture", mappedModel: "fixture", billedModel: "fixture",
				endpoint: "chat", dialect: "openai", stream: false, quota: 50,
				elapsedMs: 10, status: "success" as const, httpStatus: 200, ipHash: "",
			}
			await Promise.all(Array.from({ length: 6 }, () => recordUsage(input, { buffered: false })))
			const row = await (await usageRollups()).findOne({ _id: `user:usage-user:${hourBucket()}` })
			assert.equal(row?.requests, 1)
			assert.equal(row?.quota, 50)
		})
		await t.test("a measured settlement survives a temporary Mongo outage and replays once", async () => {
			const who = await account("recovery")
			await reserveQuota(who, "recovery", 500)
			const original = db.transaction.bind(db)
			db.transaction = async () => { throw new Error("injected database outage") }
			try {
				assert.equal((await finalizeQuota(who, "recovery", 125)).applied, false)
			} finally {
				db.transaction = original
			}
			assert.equal(await redisCommand(["LLEN", K.quotaSettlementBuffer()]), 1)
			assert.equal(await flushQuotaSettlements(), 1)
			assert.equal(await flushQuotaSettlements(), 0)
			assert.equal(await currentBalance(who), 875)
		})
		await t.test("multiple accounts may omit email, but usernames remain unique", async () => {
			await createUser({ username: "no-email-a" })
			await createUser({ username: "no-email-b" })
			const results = await Promise.allSettled([
				createUser({ username: "duplicate-name" }), createUser({ username: "duplicate-name" }),
			])
			assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
		})
	} finally {
		setDb(null)
		await closeMongo()
		const cleanup = new MongoClient(uri!)
		try {
			await cleanup.db(databaseName).dropDatabase()
		} finally {
			await cleanup.close()
		}
	}
})