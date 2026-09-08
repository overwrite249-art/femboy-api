import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createUser, createToken, updateUser, updateToken } from "../../lib/admin/store.ts"
import { createRedemptionBatch, redeemCode } from "../../lib/admin/catalog.ts"
import { authenticate } from "../../lib/auth/authenticate.ts"
import { setDb, users, tokens, usageRollups } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { currentBalance, reserveQuota, settleQuota, releaseQuota } from "../../lib/quota/index.ts"
import { recordUsage, hourBucket } from "../../lib/usage/index.ts"

beforeEach(() => {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	process.env.KEY_PEPPER = "ledger-fixture-pepper"
	process.env.IP_HASH_SECRET = "ledger-fixture-ip"
	process.env.MIN_AUTH_LATENCY_MS = "0"
})

async function account(username = "member", quota = 1000, limited = false) {
	const user = await createUser({ username, quota })
	const minted = await createToken({ userId: user._id, quota, unlimitedQuota: !limited })
	const auth = await authenticate(new Request("https://gateway.test/v1/models", {
		headers: { authorization: `Bearer ${minted.key}` },
	}))
	return { user, token: minted.token, who: auth.identity }
}

test("settled money and lifetime spend are durable, not only Redis counters", async () => {
	const { user, token, who } = await account("member", 1000, true)
	await reserveQuota(who, "r1", 800)
	await settleQuota(who, "r1", 150)
	assert.equal((await (await users()).findOne({ _id: user._id }))?.quota, 850)
	assert.equal((await (await users()).findOne({ _id: user._id }))?.usedQuota, 150)
	assert.equal((await (await tokens()).findOne({ _id: token._id }))?.quota, 850)
	assert.equal((await (await tokens()).findOne({ _id: token._id }))?.usedQuota, 150)
})

test("losing or evicting Redis cannot reset a spent balance", async () => {
	const { who } = await account()
	await reserveQuota(who, "r1", 800)
	await settleQuota(who, "r1", 600)
	setRedis(new MemoryRedis())
	assert.equal(await currentBalance(who), 400)
	await assert.rejects(reserveQuota(who, "r2", 600), /insufficient quota/i)
})

test("open reservations survive Redis loss and can still be released once", async () => {
	const { who } = await account()
	await reserveQuota(who, "r1", 600)
	setRedis(new MemoryRedis())
	assert.equal(await currentBalance(who), 400)
	assert.equal((await releaseQuota(who, "r1")).released, true)
	assert.equal(await currentBalance(who), 1000)
	assert.equal((await releaseQuota(who, "r1")).released, false)
})

test("redeeming credit cannot erase earlier spending", async () => {
	const { user, who } = await account()
	await reserveQuota(who, "r1", 600)
	await settleQuota(who, "r1", 500)
	const batch = await createRedemptionBatch({ count: 1, quota: 42, createdBy: "root" })
	const redemption = await redeemCode(batch.codes[0], user._id)
	assert.equal(redemption.balance, 542)
	assert.equal(await currentBalance(who), 542)
})

test("administrative balance changes take effect on the next reservation", async () => {
	const { user, who } = await account()
	await currentBalance(who)
	await updateUser(user._id, { quota: 100 })
	assert.equal(await currentBalance(who), 100)
	await assert.rejects(reserveQuota(who, "r1", 200), /insufficient quota/i)
})

test("a changed token limit is read from storage, not a cached identity", async () => {
	const { token, who } = await account()
	await updateToken(token._id, { unlimitedQuota: false, quota: 10 })
	await assert.rejects(reserveQuota(who, "r1", 100), /insufficient quota/i)
})

test("a reservation id cannot be reused by another account or for a different hold", async () => {
	const a = await account("first")
	const b = await account("second")
	await reserveQuota(a.who, "same-id", 100)
	await assert.rejects(reserveQuota(b.who, "same-id", 100))
	await assert.rejects(reserveQuota(a.who, "same-id", 500))
})

test("a settled request id cannot start another unmetered request", async () => {
	const { who } = await account()
	await reserveQuota(who, "same-id", 100)
	await settleQuota(who, "same-id", 50)
	await assert.rejects(reserveQuota(who, "same-id", 100))
})

test("invalid financial numbers never mutate a balance", async () => {
	const { who } = await account()
	for (const amount of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(reserveQuota(who, "invalid", amount))
		assert.equal(await currentBalance(who), 1000)
	}
})

test("concurrent duplicate usage rows increment rollups only once", async () => {
	const input = {
		requestId: "replayed", userId: "u1", tokenId: "t1", channelId: "c1", group: "default",
		model: "gpt-4o", mappedModel: "gpt-4o", billedModel: "gpt-4o",
		endpoint: "chat", dialect: "openai", stream: false, quota: 123, elapsedMs: 50,
		status: "success" as const, httpStatus: 200, ipHash: "",
	}
	await Promise.all(Array.from({ length: 5 }, () => recordUsage(input, { buffered: false })))
	const total = await (await usageRollups()).findOne({ _id: `global:all:${hourBucket()}` })
	assert.equal(total?.requests, 1)
	assert.equal(total?.quota, 123)
})