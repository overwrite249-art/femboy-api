/**
 * Redis access layer.
 *
 * Talks to Upstash over its REST API (works on every runtime, including Edge,
 * without a TCP socket) and transparently falls back to the in-process twin
 * when no credentials are configured.
 *
 * IMPORTANT (GW-015): the limiter must never fail open. If Redis is
 * unreachable, `isDegraded()` becomes true and the caller is expected to apply
 * the conservative local fallback instead of skipping the check.
 */

import { config } from "../config/env.ts"
import { MemoryRedis } from "./memory.ts"
import { SCRIPTS, type ScriptName } from "./lua.ts"

export type RedisKind = "upstash" | "memory"

export type RedisLike = {
	readonly kind: RedisKind
	command(args: Array<string | number>): Promise<unknown>
	pipeline(commands: Array<Array<string | number>>): Promise<unknown[]>
}

class UpstashRedis implements RedisLike {
	readonly kind = "upstash" as const
	private url: string
	private token: string

	constructor(url: string, token: string) {
		this.url = url.replace(/\/+$/, "")
		this.token = token
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), 5_000)
		try {
			const res = await fetch(`${this.url}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
				cache: "no-store",
			})
			if (!res.ok) {
				throw new Error(`redis http ${res.status}`)
			}
			return await res.json()
		} finally {
			clearTimeout(timer)
		}
	}

	async command(args: Array<string | number>): Promise<unknown> {
		const payload = (await this.post("", args)) as { result?: unknown; error?: string }
		if (payload && typeof payload === "object" && "error" in payload && payload.error) {
			throw new Error(String(payload.error))
		}
		return payload?.result ?? null
	}

	async pipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
		if (commands.length === 0) return []
		const payload = (await this.post("/pipeline", commands)) as Array<{
			result?: unknown
			error?: string
		}>
		return payload.map((entry) => {
			if (entry.error) throw new Error(entry.error)
			return entry.result ?? null
		})
	}
}

let instance: RedisLike | null = null
let degradedUntil = 0
let lastError = ""

export function getRedis(): RedisLike {
	if (instance) return instance
	const url = config.redisUrl
	const token = config.redisToken
	instance = url && token ? new UpstashRedis(url, token) : new MemoryRedis()
	return instance
}

/** Test/harness hook. */
export function setRedis(next: RedisLike | null): void {
	instance = next
	degradedUntil = 0
	lastError = ""
}

/** True when the shared store recently failed; callers must fail closed. */
export function isDegraded(): boolean {
	return Date.now() < degradedUntil
}

export function degradationReason(): string {
	return isDegraded() ? lastError : ""
}

function markDegraded(error: unknown): void {
	degradedUntil = Date.now() + 5_000
	lastError = error instanceof Error ? error.message : String(error)
}

function markHealthy(): void {
	degradedUntil = 0
	lastError = ""
}

/** Executes a command, converting transport faults into a degraded signal. */
export async function redisCommand(args: Array<string | number>): Promise<unknown> {
	try {
		const result = await getRedis().command(args)
		markHealthy()
		return result
	} catch (error) {
		markDegraded(error)
		throw error
	}
}

export async function redisPipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
	try {
		const result = await getRedis().pipeline(commands)
		markHealthy()
		return result
	} catch (error) {
		markDegraded(error)
		throw error
	}
}

// -- convenience wrappers ----------------------------------------------------

export async function redisGet(key: string): Promise<string | null> {
	const value = await redisCommand(["GET", key])
	if (value === null || value === undefined) return null
	return typeof value === "string" ? value : JSON.stringify(value)
}

export async function redisSet(key: string, value: string, ttlSec?: number): Promise<void> {
	if (ttlSec && ttlSec > 0) await redisCommand(["SET", key, value, "EX", Math.ceil(ttlSec)])
	else await redisCommand(["SET", key, value])
}

export async function redisSetNx(key: string, value: string, ttlSec: number): Promise<boolean> {
	const res = await redisCommand(["SET", key, value, "EX", Math.ceil(ttlSec), "NX"])
	return res === "OK"
}

export async function redisDel(...keys: string[]): Promise<number> {
	if (keys.length === 0) return 0
	const res = await redisCommand(["DEL", ...keys])
	return typeof res === "number" ? res : 0
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
	const raw = await redisGet(key)
	if (raw === null) return null
	try {
		return JSON.parse(raw) as T
	} catch {
		return null
	}
}

export async function redisSetJson(key: string, value: unknown, ttlSec?: number): Promise<void> {
	await redisSet(key, JSON.stringify(value), ttlSec)
}

export async function redisIncrBy(key: string, delta: number): Promise<number> {
	const res = await redisCommand(["INCRBY", key, Math.trunc(delta)])
	return typeof res === "number" ? res : Number(res ?? 0)
}

/** Acquires a short-lived distributed lock. Returns a release function or null. */
export async function acquireLock(
	name: string,
	ttlSec: number,
): Promise<null | (() => Promise<void>)> {
	const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
	const ok = await redisSetNx(name, token, ttlSec)
	if (!ok) return null
	return async () => {
		const current = await redisGet(name)
		if (current === token) await redisDel(name)
	}
}

// -- scripts ------------------------------------------------------------------

/**
 * Runs one of the named atomic scripts.
 *
 * On Upstash the Lua source is EVAL'd (single atomic server-side operation).
 * On the memory driver the JavaScript twin runs inside one synchronous turn of
 * the event loop, which is equally indivisible for our purposes.
 */
export async function runScript(
	name: ScriptName,
	keys: string[],
	args: Array<string | number>,
): Promise<number[]> {
	const redis = getRedis()
	if (redis.kind === "upstash") {
		const raw = await redisCommand(["EVAL", SCRIPTS[name], keys.length, ...keys, ...args])
		return normalizeScriptResult(raw)
	}
	const { runScriptTwin } = await import("./scripts.ts")
	return runScriptTwin(redis, name, keys, args)
}

function normalizeScriptResult(raw: unknown): number[] {
	if (Array.isArray(raw)) return raw.map((v) => Number(v ?? 0))
	if (typeof raw === "number") return [raw]
	if (typeof raw === "string") return [Number(raw)]
	return [0]
}
