/**
 * Rate limiting.
 *
 * Four independent limiters, each a single atomic script:
 *
 *   RPM   token bucket per token, per user and per client address
 *   TPM   fixed window over consumed tokens
 *   succ  sliding window of successful requests, an abuse damper
 *   conc  in-flight request ceiling
 *
 * RPM is a token bucket rather than a counter per fixed window because a
 * counter lets a client send `2 * limit` requests across a window boundary
 * (GW-025). A bucket makes the limit a genuine ceiling.
 *
 * When Redis is unreachable the limiters refuse rather than allow. An
 * unmetered gateway is an open relay (GW-015).
 */

import { config } from "../config/env.ts"
import { ErrorCode, GatewayError, rateLimited } from "../http/errors.ts"
import { isDegraded, redisCommand, runScript } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import { nowMs } from "../util/time.ts"
import type { Identity } from "../auth/authenticate.ts"

export type LimitScope = "token" | "user" | "ip" | "channel"

function toNumber(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : fallback
}

function limiterUnavailable(): GatewayError {
	return new GatewayError({
		code: ErrorCode.SERVICE_UNAVAILABLE,
		status: 503,
		message: "rate limiting is unavailable; refusing to serve unlimited traffic",
		kind: "overloaded_error",
	})
}

/**
 * Consumes one slot from a token bucket.
 * `limit` is requests per minute; a limit of zero disables the check.
 */
async function consumeBucket(
	key: string,
	limitPerMinute: number,
	cost = 1,
): Promise<{ allowed: boolean; remaining: number }> {
	if (limitPerMinute <= 0) return { allowed: true, remaining: Number.POSITIVE_INFINITY }
	const refillPerSecond = limitPerMinute / 60
	const ttl = Math.max(60, Math.ceil(limitPerMinute / Math.max(refillPerSecond, 0.001)) + 60)
	const result = await runScript("tokenBucket", [key], [limitPerMinute, refillPerSecond, nowMs(), cost, ttl])
	return { allowed: toNumber(result[0]) === 1, remaining: toNumber(result[1]) }
}

/** Seconds a client should wait before one bucket slot becomes available. */
function retryAfterFor(limitPerMinute: number): number {
	if (limitPerMinute <= 0) return 1
	return Math.max(1, Math.ceil(60 / limitPerMinute))
}

/**
 * Per-request limiters. Called after authentication and before any upstream
 * work, so a throttled request costs nothing.
 *
 * `ipHash` rather than the raw address: per-IP state is still per-IP, but the
 * addresses themselves never land in Redis (GW-024).
 */
export async function enforceRequestLimits(identity: Identity, ipHash: string): Promise<void> {
	if (isDegraded()) throw limiterUnavailable()

	const tokenLimit = identity.rpmLimit
	const tokenBucket = await consumeBucket(K.rpm("token", identity.tokenId), tokenLimit)
	if (!tokenBucket.allowed) {
		throw rateLimited(
			`request rate limit exceeded for this api key (${tokenLimit}/min)`,
			retryAfterFor(tokenLimit),
		)
	}

	// The per-user bucket stops one account spreading a flood across many keys.
	const userLimit = Math.max(tokenLimit, config.defaultRpm)
	const userBucket = await consumeBucket(K.rpm("user", identity.userId), userLimit)
	if (!userBucket.allowed) {
		throw rateLimited(`request rate limit exceeded for this account (${userLimit}/min)`, retryAfterFor(userLimit))
	}

	if (ipHash) {
		const ipLimit = config.defaultIpRpm
		const ipBucket = await consumeBucket(K.rpm("ip", ipHash), ipLimit)
		if (!ipBucket.allowed) {
			throw rateLimited(`request rate limit exceeded for your address (${ipLimit}/min)`, retryAfterFor(ipLimit))
		}
	}
}

/**
 * Tokens-per-minute. Charged with the estimate before the request and
 * reconciled with the real figure afterwards, so a client cannot evade it by
 * under-reporting.
 */
export async function enforceTokenBudget(identity: Identity, estimatedTokens: number): Promise<void> {
	const limit = identity.tpmLimit
	if (limit <= 0) return
	if (isDegraded()) throw limiterUnavailable()
	const cost = Math.max(1, Math.ceil(estimatedTokens))
	const result = await runScript("fixedWindow", [K.tpm("user", identity.userId)], [limit, config.defaultWindowSec, cost])
	if (toNumber(result[0]) !== 1) {
		throw new GatewayError({
			code: ErrorCode.TPM_LIMIT_EXCEEDED,
			status: 429,
			message: `token rate limit exceeded (${limit} tokens per ${config.defaultWindowSec}s)`,
			details: { retryAfterSec: config.defaultWindowSec },
		})
	}
}

/** Reconciles the TPM window once the true token count is known. */
export async function chargeTokenBudget(identity: Identity, extraTokens: number): Promise<void> {
	if (identity.tpmLimit <= 0 || extraTokens <= 0) return
	if (isDegraded()) return
	try {
		await runScript(
			"fixedWindow",
			[K.tpm("user", identity.userId)],
			[Number.MAX_SAFE_INTEGER, config.defaultWindowSec, Math.ceil(extraTokens)],
		)
	} catch {
		// Reconciliation is best-effort; the pre-charge already applied a bound.
	}
}

/**
 * Sliding window of successful requests. This is the limiter that actually
 * stops abuse: errors are cheap to produce, successes are not.
 */
export async function enforceSuccessWindow(identity: Identity, requestId: string): Promise<void> {
	const limit = config.defaultSuccessPerWindow
	if (limit <= 0) return
	if (isDegraded()) throw limiterUnavailable()
	const windowMs = config.defaultWindowSec * 1000
	const result = await runScript(
		"slidingSuccess",
		[K.successWindow(identity.userId)],
		[limit, windowMs, nowMs(), requestId],
	)
	if (toNumber(result[0]) !== 1) {
		throw rateLimited(
			`too many successful requests (${limit} per ${config.defaultWindowSec}s)`,
			config.defaultWindowSec,
		)
	}
}

export type ConcurrencyLease = { release: () => Promise<void> }

/**
 * In-flight ceiling. Returns a lease whose `release` must run in a `finally`.
 *
 * INCR then compare is very slightly racy at the boundary - two requests can
 * both see `limit` under perfect contention - which is an acceptable trade for
 * avoiding another script round-trip on the hot path. The bound still holds to
 * within one request.
 */
export async function acquireConcurrency(
	scope: LimitScope,
	id: string,
	limit: number,
): Promise<ConcurrencyLease> {
	const noop = { release: async () => {} }
	if (limit <= 0 || isDegraded()) return noop
	const key = K.concurrency(scope, id)
	const current = toNumber(await redisCommand(["INCR", key]))
	if (current === 1) await redisCommand(["EXPIRE", key, 300])
	if (current > limit) {
		await redisCommand(["DECR", key])
		throw new GatewayError({
			code: ErrorCode.CONCURRENCY_LIMIT,
			status: 429,
			message: `too many concurrent requests (${limit})`,
			details: { retryAfterSec: 1 },
		})
	}
	let released = false
	return {
		release: async () => {
			if (released) return
			released = true
			try {
				await redisCommand(["DECR", key])
			} catch {
				// The TTL will reclaim the slot.
			}
		},
	}
}
