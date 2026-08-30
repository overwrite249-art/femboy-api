/**
 * The quota ledger.
 *
 * Money is the part of a gateway that attackers care about, so the design is
 * deliberately paranoid:
 *
 *  - A request reserves before it runs and settles after. Both are single
 *    atomic scripts, so two concurrent requests cannot each observe the same
 *    balance and both pass (GW-001).
 *  - The reservation id is the request id, which makes every operation
 *    idempotent. A retried settlement, or a settlement that races an abort
 *    handler, cannot debit twice (GW-009).
 *  - Redis holds the hot counter; MongoDB holds the truth. The counter is
 *    seeded from Mongo on first touch and every mutation is journalled, so an
 *    evicted key costs a reconciliation, not revenue.
 *  - If the ledger cannot be reached the request is refused. Serving traffic
 *    we cannot meter is strictly worse than serving an error (GW-015).
 */

import { config } from "../config/env.ts"
import { ErrorCode, GatewayError, insufficientQuota } from "../http/errors.ts"
import { tokens, users } from "../db/index.ts"
import { isDegraded, redisGet, redisSetNx, runScript } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import type { Identity } from "../auth/authenticate.ts"

/** How long an unsettled reservation survives before the cron reclaims it. */
export const RESERVATION_TTL_SEC = 900
/** How long journal entries stay available for reconciliation. */
export const JOURNAL_TTL_SEC = 7 * 24 * 3600
/** Re-seed the counter from MongoDB at most this often. */
const HYDRATION_TTL_SEC = 7 * 24 * 3600

/** Reserve outcomes, mirroring the script's first return element. */
const RESERVE_REFUSED = 0
const RESERVE_OK = 1
const RESERVE_REPLAY = 2
const RESERVE_NO_LEDGER = 3

export type ReserveResult = {
	reservationId: string
	reserved: number
	remaining: number
	/** True when this exact request id had already reserved. */
	replayed: boolean
}

export type SettleResult = {
	/** False when the reservation had already been settled or released. */
	applied: boolean
	remaining: number
}

function ledgerUnavailable(detail: string): GatewayError {
	return new GatewayError({
		code: ErrorCode.SERVICE_UNAVAILABLE,
		status: 503,
		message: `the quota ledger is unavailable (${detail}); refusing to serve unmetered traffic`,
		kind: "overloaded_error",
	})
}

function toNumber(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : fallback
}

/**
 * Seeds a hot counter from MongoDB if it is absent, then returns its value.
 *
 * Set-if-absent, never plain SET: concurrent requests all find the key missing
 * at the same moment, and a blind write would let each of them restore the
 * full balance after its neighbours had already spent from it.
 */
async function hydrate(key: string, load: () => Promise<number>): Promise<number> {
	const existing = await redisGet(key)
	if (existing !== null) return toNumber(existing)

	const value = await load()
	const seeded = await redisSetNx(key, String(value), HYDRATION_TTL_SEC)
	if (seeded) return value

	// Someone else seeded it first; theirs is authoritative.
	const raced = await redisGet(key)
	return raced === null ? value : toNumber(raced)
}

export async function hydrateUserQuota(userId: string): Promise<number> {
	return hydrate(K.userQuota(userId), async () => {
		const collection = await users()
		const doc = await collection.findOne({ _id: userId })
		return Math.max(0, Math.floor(doc?.quota ?? 0))
	})
}

export async function hydrateTokenQuota(tokenId: string): Promise<number> {
	return hydrate(K.tokenQuota(tokenId), async () => {
		const collection = await tokens()
		const doc = await collection.findOne({ _id: tokenId })
		return Math.max(0, Math.floor(doc?.quota ?? 0))
	})
}

/** The optimistic hold taken before a request runs. */
export function preConsumedQuota(): number {
	return Math.max(1, config.preConsumedQuota)
}

type LedgerKeys = { userKey: string; tokenKey: string; unlimited: number }

function ledgerKeys(identity: Identity): LedgerKeys {
	return {
		userKey: K.userQuota(identity.userId),
		// An empty key tells the script to skip the per-token leg. A token marked
		// unlimited has no cap of its own, but its owner still pays for it.
		tokenKey: identity.unlimitedQuota ? "" : K.tokenQuota(identity.tokenId),
		// The script's `unlimited` flag skips metering entirely. Relay traffic is
		// never exempt; the flag exists for internal, non-billable calls.
		unlimited: 0,
	}
}

/**
 * Places a hold. Throws `insufficient_quota` when neither the account nor the
 * key can cover it.
 *
 * Keying the reservation by request id means a client that retries with the
 * same id gets the same hold rather than a second one.
 */
export async function reserveQuota(
	identity: Identity,
	requestId: string,
	amount: number,
): Promise<ReserveResult> {
	if (isDegraded()) throw ledgerUnavailable("cache offline")
	const need = Math.max(1, Math.ceil(amount))
	const { userKey, tokenKey, unlimited } = ledgerKeys(identity)

	await hydrateUserQuota(identity.userId)
	if (tokenKey !== "") await hydrateTokenQuota(identity.tokenId)

	const result = await runScript(
		"reserve",
		[userKey, tokenKey, K.reservation(requestId)],
		[need, RESERVATION_TTL_SEC, requestId, unlimited],
	)
	const status = toNumber(result[0])
	const remaining = toNumber(result[1])

	if (status === RESERVE_REFUSED) {
		throw insufficientQuota(
			`insufficient quota: ${need} required, ${Math.max(0, remaining)} available`,
		)
	}
	// The counter vanished between hydration and execution. Refuse rather than
	// treat an absent balance as a limitless one.
	if (status === RESERVE_NO_LEDGER) throw ledgerUnavailable("balance not initialised")

	return {
		reservationId: requestId,
		reserved: need,
		remaining,
		replayed: status === RESERVE_REPLAY,
	}
}

/**
 * Converts a hold into a charge.
 *
 * `actual` may be smaller than the reservation (the common case - the estimate
 * is deliberately generous) or larger (a long completion). The script settles
 * the delta against what was held, so the balance ends up correct either way.
 */
export async function settleQuota(
	identity: Identity,
	requestId: string,
	actual: number,
): Promise<SettleResult> {
	const charge = Math.max(0, Math.ceil(actual))
	const { userKey, tokenKey } = ledgerKeys(identity)
	const result = await runScript(
		"settle",
		[userKey, tokenKey, K.reservation(requestId), K.quotaJournal()],
		[charge, requestId, identity.userId, identity.tokenId, JOURNAL_TTL_SEC],
	)
	return { applied: toNumber(result[0]) === RESERVE_OK, remaining: toNumber(result[1]) }
}

/**
 * Cancels a hold without charging - used when the request failed before any
 * upstream work happened, or when the client disconnected mid-flight.
 */
export async function releaseQuota(
	identity: Identity,
	requestId: string,
): Promise<{ released: boolean; refunded: number }> {
	const { userKey, tokenKey } = ledgerKeys(identity)
	const result = await runScript(
		"release",
		[userKey, tokenKey, K.reservation(requestId), K.quotaJournal()],
		[requestId, identity.userId, identity.tokenId, JOURNAL_TTL_SEC],
	)
	return { released: toNumber(result[0]) === RESERVE_OK, refunded: toNumber(result[1]) }
}

/**
 * Settles if the request produced billable work, releases otherwise. Safe to
 * call more than once; the ledger scripts are idempotent.
 */
export async function finalizeQuota(
	identity: Identity,
	requestId: string,
	actual: number,
): Promise<SettleResult> {
	if (actual <= 0) {
		const released = await releaseQuota(identity, requestId)
		return { applied: released.released, remaining: 0 }
	}
	return settleQuota(identity, requestId, actual)
}

/** Current balance as the hot path sees it. For display only. */
export async function currentBalance(identity: Identity): Promise<number> {
	const value = await redisGet(K.userQuota(identity.userId))
	if (value !== null) return toNumber(value)
	return hydrateUserQuota(identity.userId)
}
