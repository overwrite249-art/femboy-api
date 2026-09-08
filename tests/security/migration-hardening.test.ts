import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createUser, createToken } from "../../lib/admin/store.ts"
import { getDb, setDb, users, tokens, usageLogs } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis, redisCommand } from "../../lib/redis/client.ts"
import { K } from "../../lib/redis/keys.ts"
import { applyBalancePlan, exportBalancePlan } from "../../lib/quota/migrate.ts"

beforeEach(() => {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	process.env.KEY_PEPPER = "migration-pepper-fixture"
})

async function legacyAccount() {
	const user = await createUser({ username: "legacy", quota: 1000 })
	const { token } = await createToken({ userId: user._id, quota: 500 })
	await (await users()).updateOne({ _id: user._id }, { $unset: { quotaLedgerVersion: "" } })
	await (await tokens()).updateOne({ _id: token._id }, { $unset: { quotaLedgerVersion: "" } })
	return { user, token }
}

test("missing hot counters export as unknown, never stale Mongo balances", async () => {
	await legacyAccount()
	const plan = await exportBalancePlan(await getDb())
	assert.equal(plan.reviewed, false)
	assert.equal(plan.balances.length, 2)
	assert.ok(plan.balances.every((row) => row.remaining === null))
	await assert.rejects(applyBalancePlan(await getDb(), plan), /reviewed/)
	plan.reviewed = true
	await assert.rejects(applyBalancePlan(await getDb(), plan), /unreconciled/)
})

test("malformed Redis money is unknown rather than implicitly zero", async () => {
	const { user } = await legacyAccount()
	for (const value of ["", " ", "NaN", "1.5", "1e3"]) {
		await redisCommand(["SET", K.userQuota(user._id), value])
		const plan = await exportBalancePlan(await getDb())
		assert.equal(plan.balances.find((row) => row.kind === "user")?.remaining, null)
	}
})

test("a reviewed migration applies reconciled balances exactly once", async () => {
	const { user, token } = await legacyAccount()
	await redisCommand(["SET", K.userQuota(user._id), "600"])
	await redisCommand(["SET", K.tokenQuota(token._id), "250"])
	const db = await getDb()
	const plan = await exportBalancePlan(db)
	plan.reviewed = true
	plan.balances.find((row) => row.kind === "user")!.usedQuota = 400
	assert.equal(await applyBalancePlan(db, plan), 2)
	assert.equal(await applyBalancePlan(db, plan), 0)
	const after = await (await users()).findOne({ _id: user._id })
	assert.equal(after?.quota, 600)
	assert.equal(after?.legacyUsedQuota, 400)
	assert.equal(after?.quotaLedgerVersion, 2)
	assert.equal((await (await tokens()).findOne({ _id: token._id }))?.quota, 250)
	assert.deepEqual((await exportBalancePlan(db)).balances, [])
})

test("invalid or duplicated plan rows are rejected before any write", async () => {
	const { user } = await legacyAccount()
	const db = await getDb()
	const plan = await exportBalancePlan(db)
	plan.reviewed = true
	for (const row of plan.balances) row.remaining = 10
	plan.balances.push(plan.balances[0])
	await assert.rejects(applyBalancePlan(db, plan), /duplicate/)
	assert.equal((await (await users()).findOne({ _id: user._id }))?.quotaLedgerVersion, undefined)
})

test("a balance edited after export cannot be overwritten by a stale plan", async () => {
	const { user } = await legacyAccount()
	const db = await getDb()
	const plan = await exportBalancePlan(db)
	plan.reviewed = true
	for (const row of plan.balances) row.remaining = 10
	await (await users()).updateOne({ _id: user._id }, { $set: { quota: 999 } })
	await assert.rejects(applyBalancePlan(db, plan), /changed after export/)
	assert.equal((await (await users()).findOne({ _id: user._id }))?.quota, 999)
})

test("a failed usage-index initialization fails closed and is retried", async () => {
	const db = new MemoryDatabase()
	const original = db.collection.bind(db)
	let attempts = 0
	db.collection = <T extends { _id: string }>(name: string) => {
		const collection = original<T>(name)
		collection.createIndexes = async () => {
			attempts++
			if (attempts === 1) throw new Error("injected index failure")
		}
		return collection
	}
	setDb(db)
	await assert.rejects(usageLogs("209901"), /injected/)
	await usageLogs("209901")
	await usageLogs("209901")
	assert.equal(attempts, 2)
})