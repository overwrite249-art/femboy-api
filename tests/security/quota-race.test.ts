import test from "node:test"
import assert from "node:assert/strict"

process.env.KEY_PEPPER = "unit-test-pepper-000000000000000000000000"
process.env.PRE_CONSUMED_QUOTA = "1000"

import { setDb, tokens, users } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import {
	currentBalance,
	finalizeQuota,
	releaseQuota,
	reserveQuota,
	settleQuota,
} from "../../lib/quota/index.ts"
import type { Identity } from "../../lib/auth/authenticate.ts"

function identity(overrides: Partial<Identity> = {}): Identity {
	return {
		tokenId: "t1",
		tokenName: "primary",
		keyPrefix: "abcd1234",
		keyLast4: "wxyz",
		userId: "u1",
		username: "kit",
		role: "user",
		group: "default",
		unlimitedQuota: true,
		tokenQuota: 0,
		userQuota: 1000,
		allowedIps: [],
		allowedModels: [],
		rpmLimit: 60,
		tpmLimit: 0,
		...overrides,
	}
}

async function seed(userQuota: number, tokenQuota = 0) {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	const now = new Date()
	const userCollection = await users()
	await userCollection.insertOne({
		_id: "u1",
		username: "kit",
		displayName: "Kit",
		email: "kit@example.test",
		role: "user",
		status: "enabled",
		group: "default",
		quota: userQuota,
		usedQuota: 0,
		requestCount: 0,
		createdAt: now,
		updatedAt: now,
	})
	const tokenCollection = await tokens()
	await tokenCollection.insertOne({
		_id: "t1",
		userId: "u1",
		name: "primary",
		keyPrefix: "abcd1234",
		keyDigest: "0".repeat(64),
		keyLast4: "wxyz",
		status: "enabled",
		quota: tokenQuota,
		usedQuota: 0,
		unlimitedQuota: tokenQuota === 0,
		expiresAt: null,
		allowedIps: [],
		allowedModels: [],
		createdAt: now,
		updatedAt: now,
	})
}

test("a reservation holds immediately and a short balance is refused", async () => {
	await seed(1000)
	const who = identity()

	const first = await reserveQuota(who, "req-1", 600)
	assert.equal(first.reserved, 600)
	assert.equal(first.remaining, 400)
	assert.equal(first.replayed, false)

	await assert.rejects(() => reserveQuota(who, "req-2", 600), /insufficient quota/i)

	// A refused reservation must not have moved the balance.
	assert.equal(await currentBalance(who), 400)
})

test("concurrent reservations cannot oversell the balance", async () => {
	await seed(1000)
	const who = identity()

	const attempts = Array.from({ length: 10 }, (_, i) =>
		reserveQuota(who, `race-${i}`, 200).then(
			() => "ok",
			() => "refused",
		),
	)
	const outcomes = await Promise.all(attempts)
	const granted = outcomes.filter((o) => o === "ok").length

	assert.equal(granted, 5, `expected exactly 5 of 10 to be granted, got ${granted}`)
	assert.equal(await currentBalance(who), 0)
})

test("a replayed request id reuses its hold instead of taking a second", async () => {
	await seed(1000)
	const who = identity()

	const first = await reserveQuota(who, "idem-1", 300)
	assert.equal(first.replayed, false)
	const balanceAfterFirst = await currentBalance(who)

	const second = await reserveQuota(who, "idem-1", 300)
	assert.equal(second.replayed, true)
	assert.equal(await currentBalance(who), balanceAfterFirst)
})

test("settling less than reserved refunds the difference", async () => {
	await seed(1000)
	const who = identity()

	await reserveQuota(who, "settle-1", 800)
	assert.equal(await currentBalance(who), 200)

	const settled = await settleQuota(who, "settle-1", 150)
	assert.equal(settled.applied, true)
	assert.equal(await currentBalance(who), 850)
})

test("settling more than reserved charges the overage", async () => {
	await seed(1000)
	const who = identity()

	await reserveQuota(who, "settle-2", 100)
	await settleQuota(who, "settle-2", 400)
	assert.equal(await currentBalance(who), 600)
})

test("a settlement cannot be applied twice", async () => {
	await seed(1000)
	const who = identity()

	await reserveQuota(who, "double-1", 500)
	await settleQuota(who, "double-1", 200)
	const balance = await currentBalance(who)

	const replay = await settleQuota(who, "double-1", 200)
	assert.equal(replay.applied, false)
	assert.equal(await currentBalance(who), balance)
})

test("releasing refunds the whole hold and is idempotent", async () => {
	await seed(1000)
	const who = identity()

	await reserveQuota(who, "rel-1", 700)
	assert.equal(await currentBalance(who), 300)

	const released = await releaseQuota(who, "rel-1")
	assert.equal(released.released, true)
	assert.equal(await currentBalance(who), 1000)

	const again = await releaseQuota(who, "rel-1")
	assert.equal(again.released, false)
	assert.equal(await currentBalance(who), 1000)
})

test("an aborted request releases rather than charges", async () => {
	await seed(1000)
	const who = identity()

	await reserveQuota(who, "abort-1", 250)
	await finalizeQuota(who, "abort-1", 0)
	assert.equal(await currentBalance(who), 1000)
})

test("a settlement after a release does not resurrect the charge", async () => {
	await seed(1000)
	const who = identity()

	await reserveQuota(who, "order-1", 400)
	await releaseQuota(who, "order-1")
	const settled = await settleQuota(who, "order-1", 400)
	assert.equal(settled.applied, false)
	assert.equal(await currentBalance(who), 1000)
})

test("a token-limited key is metered against both ledgers", async () => {
	await seed(1000, 300)
	const who = identity({ unlimitedQuota: false, tokenQuota: 300 })

	// The token leg is the tighter of the two and must bind.
	await assert.rejects(() => reserveQuota(who, "tok-1", 500), /insufficient quota/i)

	const ok = await reserveQuota(who, "tok-2", 200)
	assert.equal(ok.reserved, 200)
	assert.equal(await currentBalance(who), 800)
})
