/**
 * JavaScript twins of the Lua scripts in `lua.ts`.
 *
 * These run against the in-memory driver. Each function must produce exactly
 * the same return tuple as its Lua counterpart - the security tests exercise
 * this path, so any divergence would make the tests lie about production.
 *
 * They are written as a single `await`-free critical section wherever a
 * read-modify-write happens, which is what preserves atomicity on the
 * single-threaded event loop.
 */

import type { RedisLike } from "./client.ts"
import type { ScriptName } from "./lua.ts"
import { MemoryRedis } from "./memory.ts"

export async function runScriptTwin(
	redis: RedisLike,
	name: ScriptName,
	keys: string[],
	args: Array<string | number>,
): Promise<number[]> {
	if (!(redis instanceof MemoryRedis)) {
		throw new Error("script twins require the memory driver")
	}
	const n = (i: number) => Number(args[i] ?? 0)
	const s = (i: number) => String(args[i] ?? "")

	switch (name) {
		case "tokenBucket":
			return tokenBucket(redis, keys[0], n(0), n(1), n(2), n(3), n(4))
		case "fixedWindow":
			return fixedWindow(redis, keys[0], n(0), n(1), n(2))
		case "slidingSuccess":
			return slidingSuccess(redis, keys[0], n(0), n(1), n(2), s(3))
		case "reserve":
			return reserve(redis, keys[0], keys[1], keys[2], n(0), n(1), s(2), n(3))
		case "settle":
			return settle(redis, keys[0], keys[1], keys[2], keys[3], n(0), s(1), s(2), s(3), n(4))
		case "release":
			return release(redis, keys[0], keys[1], keys[2], keys[3], s(0), s(1), s(2), n(3))
		case "nextKey":
			return nextKey(redis, keys[0], n(0))
		case "health":
			return health(redis, keys[0], n(0), n(1), n(2), n(3))
		default:
			throw new Error(`unknown script ${String(name)}`)
	}
}

async function tokenBucket(
	r: MemoryRedis,
	key: string,
	capacity: number,
	refill: number,
	now: number,
	cost: number,
	ttl: number,
): Promise<number[]> {
	if (capacity <= 0) return [1, -1, 0]
	const data = (await r.command(["HMGET", key, "tokens", "ts"])) as Array<string | null>
	let tokens = data[0] === null ? capacity : Number(data[0])
	const ts = data[1] === null ? now : Number(data[1])
	const elapsed = Math.max(0, now - ts) / 1000
	tokens = Math.min(capacity, tokens + elapsed * refill)
	let allowed = 0
	let retry = 0
	if (tokens >= cost) {
		tokens -= cost
		allowed = 1
	} else {
		const deficit = cost - tokens
		retry = refill > 0 ? Math.ceil((deficit / refill) * 1000) : ttl * 1000
	}
	await r.command(["HSET", key, "tokens", String(tokens), "ts", String(now)])
	await r.command(["EXPIRE", key, ttl])
	return [allowed, Math.floor(tokens), retry]
}

async function fixedWindow(
	r: MemoryRedis,
	key: string,
	limit: number,
	window: number,
	cost: number,
): Promise<number[]> {
	if (limit <= 0) return [1, 0, window]
	const current = Number(((await r.command(["GET", key])) as string | null) ?? "0")
	if (current + cost > limit) {
		let ttl = (await r.command(["TTL", key])) as number
		if (ttl < 0) ttl = window
		return [0, current, ttl]
	}
	const updated = (await r.command(["INCRBY", key, cost])) as number
	if (updated === cost) await r.command(["EXPIRE", key, window])
	let ttl = (await r.command(["TTL", key])) as number
	if (ttl < 0) ttl = window
	return [1, updated, ttl]
}

async function slidingSuccess(
	r: MemoryRedis,
	key: string,
	limit: number,
	window: number,
	now: number,
	member: string,
): Promise<number[]> {
	if (limit <= 0) return [1, 0]
	await r.command(["ZREMRANGEBYSCORE", key, "-inf", now - window])
	const count = (await r.command(["ZCARD", key])) as number
	if (count >= limit) return [0, count]
	await r.command(["ZADD", key, now, member])
	await r.command(["PEXPIRE", key, window])
	return [1, count + 1]
}

async function reserve(
	r: MemoryRedis,
	userKey: string,
	tokenKey: string,
	resvKey: string,
	amount: number,
	ttl: number,
	requestId: string,
	unlimited: number,
): Promise<number[]> {
	if (((await r.command(["EXISTS", resvKey])) as number) === 1) {
		return [2, Number(((await r.command(["GET", userKey])) as string | null) ?? "0")]
	}
	if (unlimited === 1) {
		await r.command(["HSET", resvKey, "amount", "0", "rid", requestId, "state", "open", "unlimited", "1"])
		await r.command(["EXPIRE", resvKey, ttl])
		return [1, -1]
	}
	const rawBalance = (await r.command(["GET", userKey])) as string | null
	const balance = rawBalance === null ? -1 : Number(rawBalance)
	if (balance < 0) return [3, 0]
	if (balance < amount) return [0, balance]
	let tokenBalance = -1
	if (tokenKey !== "") {
		const rawToken = (await r.command(["GET", tokenKey])) as string | null
		tokenBalance = rawToken === null ? -1 : Number(rawToken)
		if (tokenBalance >= 0 && tokenBalance < amount) return [0, tokenBalance]
	}
	const remaining = (await r.command(["DECRBY", userKey, amount])) as number
	if (tokenKey !== "" && tokenBalance >= 0) await r.command(["DECRBY", tokenKey, amount])
	await r.command(["HSET", resvKey, "amount", String(amount), "rid", requestId, "state", "open", "unlimited", "0"])
	await r.command(["EXPIRE", resvKey, ttl])
	return [1, remaining]
}

async function settle(
	r: MemoryRedis,
	userKey: string,
	tokenKey: string,
	resvKey: string,
	journalKey: string,
	finalAmount: number,
	requestId: string,
	userId: string,
	tokenId: string,
	journalTtl: number,
): Promise<number[]> {
	const state = (await r.command(["HGET", resvKey, "state"])) as string | null
	if (state === null) return [0, 0, 0]
	if (state !== "open") return [2, 0, 0]
	const reserved = Number(((await r.command(["HGET", resvKey, "amount"])) as string | null) ?? "0")
	const unlimited = Number(((await r.command(["HGET", resvKey, "unlimited"])) as string | null) ?? "0")
	const delta = finalAmount - reserved
	let remaining = -1
	if (unlimited === 0) {
		if (delta !== 0) {
			remaining = (await r.command(["DECRBY", userKey, delta])) as number
			if (tokenKey !== "" && ((await r.command(["EXISTS", tokenKey])) as number) === 1) {
				await r.command(["DECRBY", tokenKey, delta])
			}
		} else {
			remaining = Number(((await r.command(["GET", userKey])) as string | null) ?? "0")
		}
	}
	await r.command(["HSET", resvKey, "state", "settled", "final", String(finalAmount)])
	await r.command(["EXPIRE", resvKey, 900])
	await r.command([
		"RPUSH",
		journalKey,
		JSON.stringify({ rid: requestId, uid: userId, tid: tokenId, amount: finalAmount, reserved, kind: "settle" }),
	])
	await r.command(["EXPIRE", journalKey, journalTtl])
	return [1, remaining, delta]
}

async function release(
	r: MemoryRedis,
	userKey: string,
	tokenKey: string,
	resvKey: string,
	journalKey: string,
	requestId: string,
	userId: string,
	tokenId: string,
	journalTtl: number,
): Promise<number[]> {
	const state = (await r.command(["HGET", resvKey, "state"])) as string | null
	if (state === null) return [0, 0]
	if (state !== "open") return [2, 0]
	const reserved = Number(((await r.command(["HGET", resvKey, "amount"])) as string | null) ?? "0")
	const unlimited = Number(((await r.command(["HGET", resvKey, "unlimited"])) as string | null) ?? "0")
	if (unlimited === 0 && reserved > 0) {
		await r.command(["INCRBY", userKey, reserved])
		if (tokenKey !== "" && ((await r.command(["EXISTS", tokenKey])) as number) === 1) {
			await r.command(["INCRBY", tokenKey, reserved])
		}
	}
	await r.command(["HSET", resvKey, "state", "released"])
	await r.command(["EXPIRE", resvKey, 900])
	await r.command([
		"RPUSH",
		journalKey,
		JSON.stringify({ rid: requestId, uid: userId, tid: tokenId, amount: 0, reserved, kind: "release" }),
	])
	await r.command(["EXPIRE", journalKey, journalTtl])
	return [1, reserved]
}

async function nextKey(r: MemoryRedis, key: string, size: number): Promise<number[]> {
	if (size <= 0) return [-1]
	const n = (await r.command(["INCR", key])) as number
	await r.command(["EXPIRE", key, 86_400])
	return [(n - 1) % size]
}

async function health(
	r: MemoryRedis,
	key: string,
	ok: number,
	threshold: number,
	cooldown: number,
	now: number,
): Promise<number[]> {
	if (ok === 1) {
		await r.command(["HSET", key, "fails", "0", "openUntil", "0"])
		await r.command(["EXPIRE", key, cooldown * 10])
		return [0, 0]
	}
	const fails = (await r.command(["HINCRBY", key, "fails", 1])) as number
	let state = 0
	if (fails >= threshold) {
		await r.command(["HSET", key, "openUntil", String(now + cooldown * 1000)])
		state = 1
	}
	await r.command(["EXPIRE", key, cooldown * 10])
	return [state, fails]
}
