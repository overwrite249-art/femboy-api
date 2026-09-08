import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { setRedis, redisCommand, type RedisLike } from "../../lib/redis/client.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { K } from "../../lib/redis/keys.ts"
import {
	acquireConcurrency, enforceRequestLimits, enforceTokenBudget, enforceSuccessWindow,
} from "../../lib/ratelimit/index.ts"
import type { Identity } from "../../lib/auth/authenticate.ts"

const who: Identity = {
	userId: "u1", tokenId: "t1", username: "member", tokenName: "fixture",
	role: "user", group: "default", keyPrefix: "12345678", keyLast4: "1234",
	unlimitedQuota: true, userQuota: 1000, tokenQuota: 0,
	allowedIps: [], allowedModels: [], rpmLimit: 60, tpmLimit: 100,
}
const broken: RedisLike = {
	kind: "upstash",
	async command() { throw new Error("opaque transport error") },
	async pipeline() { throw new Error("opaque transport error") },
}
beforeEach(() => { setRedis(new MemoryRedis()) })
afterEach(() => { setRedis(null) })

test("all admission checks fail closed with a 503 on a fresh Redis fault", async () => {
	for (const check of [
		() => enforceRequestLimits(who, "ip"),
		() => enforceTokenBudget(who, 10),
		() => enforceSuccessWindow(who, "r"),
		() => acquireConcurrency("user", who.userId, 1),
	]) {
		setRedis(broken)
		await assert.rejects(check, (error: unknown) => {
			assert.equal((error as { status?: number }).status, 503)
			return true
		})
	}
})

test("a previously degraded store never disables a configured concurrency limit", async () => {
	setRedis(broken)
	await redisCommand(["PING"]).catch(() => {})
	await assert.rejects(acquireConcurrency("user", who.userId, 1))
})

test("releasing an expired lease cannot create a negative counter and admit extra work", async () => {
	const old = await acquireConcurrency("user", who.userId, 1)
	await redisCommand(["DEL", K.concurrency("user", who.userId)])
	await old.release()
	const active = await acquireConcurrency("user", who.userId, 1)
	await assert.rejects(acquireConcurrency("user", who.userId, 1), /concurrent/)
	await active.release()
})

test("an old lease cannot release a replacement lease after expiry", async () => {
	const old = await acquireConcurrency("user", who.userId, 1)
	await redisCommand(["DEL", K.concurrency("user", who.userId)])
	const active = await acquireConcurrency("user", who.userId, 1)
	await old.release()
	await assert.rejects(acquireConcurrency("user", who.userId, 1), /concurrent/)
	await active.release()
})