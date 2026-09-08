/**
 * Durable, transactional quota ledger.
 *
 * Redis eviction, TTL expiry, a credit, or a restart must never restore an
 * already-spent balance. Mongo transactions update balances and the request's
 * journal record together. Redis remains the shared limiter, not the money.
 * Existing deployments must migrate reviewed balances first. Unversioned
 * accounts fail closed. Atlas/a replica set is required; no unsafe fallback.
 */
import { config } from "../config/env.ts"
import { getDb, users, tokens, COLLECTIONS } from "../db/index.ts"
import type { Database } from "../db/driver.ts"
import type { UserDoc, TokenDoc, QuotaJournalDoc } from "../db/types.ts"
import { ErrorCode, GatewayError, forbidden, insufficientQuota, invalidRequest } from "../http/errors.ts"
import { isDegraded, redisCommand, redisSetNx, runScript } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import { randomHex } from "../util/crypto.ts"
import type { Identity } from "../auth/authenticate.ts"

export const QUOTA_LEDGER_VERSION = 2
export const RESERVATION_TTL_SEC = 900
export const JOURNAL_TTL_SEC = 7 * 24 * 3600

export type ReserveResult = {
	reservationId: string
	reserved: number
	remaining: number
	replayed: boolean
}
export type SettleResult = { applied: boolean; remaining: number }

function ledgerUnavailable(cause?: unknown): GatewayError {
	return new GatewayError({
		code: ErrorCode.SERVICE_UNAVAILABLE, status: 503,
		message: "the durable quota ledger is unavailable; refusing to serve unmetered traffic",
		kind: "overloaded_error", cause,
	})
}

/** Financial inputs are integral, bounded and non-negative. Stored debt is valid. */
export function quotaAmount(value: number, field = "quota"): number {
	const rounded = Math.ceil(value)
	if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(rounded)) {
		throw invalidRequest(`${field} must be a non-negative safe number`, field)
	}
	return rounded
}

function requireUpgraded(doc: { quotaLedgerVersion?: number }): void {
	if (doc.quotaLedgerVersion !== QUOTA_LEDGER_VERSION) {
		throw new GatewayError({
			code: ErrorCode.CONFIGURATION_ERROR, status: 503,
			message: "quota ledger migration is required before this account can relay",
		})
	}
}

async function transaction<T>(work: (db: Database) => Promise<T>): Promise<T> {
	try {
		return await (await getDb()).transaction(work)
	} catch (error) {
		if (GatewayError.is(error)) throw error
		throw ledgerUnavailable(error)
	}
}

/** Compatibility names: read durable balances, never hydrate expiring money. */
export async function hydrateUserQuota(userId: string): Promise<number> {
	const doc = await (await users()).findOne({ _id: userId })
	if (!doc || !Number.isSafeInteger(doc.quota)) throw ledgerUnavailable()
	requireUpgraded(doc)
	return doc.quota
}

export async function hydrateTokenQuota(tokenId: string): Promise<number> {
	const doc = await (await tokens()).findOne({ _id: tokenId })
	if (!doc || !Number.isSafeInteger(doc.quota)) throw ledgerUnavailable()
	requireUpgraded(doc)
	return doc.quota
}

export function preConsumedQuota(): number {
	return Math.max(1, quotaAmount(config.preConsumedQuota))
}

export async function reserveQuota(identity: Identity, requestId: string, amount: number): Promise<ReserveResult> {
	if (isDegraded()) throw ledgerUnavailable()
	const need = Math.max(1, quotaAmount(amount))
	if (!requestId || requestId.length > 128) throw invalidRequest("invalid reservation id")

	return transaction(async (db) => {
		const account = db.collection<UserDoc>(COLLECTIONS.users)
		const keys = db.collection<TokenDoc>(COLLECTIONS.tokens)
		const journal = db.collection<QuotaJournalDoc>(COLLECTIONS.quotaJournal)
		const existing = await journal.findOne({ _id: requestId })
		if (existing) {
			if (existing.userId !== identity.userId || existing.tokenId !== identity.tokenId ||
				existing.state !== "pending" || existing.reserved !== need ||
				!existing.expiresAt || new Date(existing.expiresAt).getTime() <= Date.now()) {
				throw invalidRequest("a reservation id cannot be reused for a different operation")
			}
			const user = await account.findOne({ _id: identity.userId })
			return { reservationId: requestId, reserved: existing.reserved, remaining: user?.quota ?? 0, replayed: true }
		}

		const user = await account.findOne({ _id: identity.userId })
		const token = await keys.findOne({ _id: identity.tokenId, userId: identity.userId })
		if (!user || user.status !== "enabled" || !token || token.status !== "enabled" ||
			(token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now())) {
			throw forbidden("this account or api key is not active")
		}
		requireUpgraded(user)
		requireUpgraded(token)
		if (!Number.isSafeInteger(user.quota) || !Number.isSafeInteger(token.quota)) throw ledgerUnavailable()
		// A cached identity may predate an operator's token-cap change.
		const tokenLimited = !token.unlimitedQuota
		if (user.quota < need || (tokenLimited && token.quota < need)) {
			throw insufficientQuota("insufficient quota for this request")
		}
		const debited = await account.findOneAndUpdate(
			{ _id: user._id, status: "enabled", quota: { $gte: need } },
			{ $inc: { quota: -need }, $set: { updatedAt: new Date() } },
		)
		if (!debited) throw insufficientQuota()
		if (tokenLimited) {
			const tokenDebit = await keys.findOneAndUpdate(
				{ _id: token._id, status: "enabled", quota: { $gte: need } },
				{ $inc: { quota: -need }, $set: { updatedAt: new Date() } },
			)
			if (!tokenDebit) throw insufficientQuota()
		}
		await journal.insertOne({
			_id: requestId, requestId, kind: "reserve", state: "pending",
			userId: user._id, tokenId: token._id, tokenLimited,
			amount: 0, reserved: need, createdAt: new Date(),
			expiresAt: new Date(Date.now() + RESERVATION_TTL_SEC * 1000),
		})
		return { reservationId: requestId, reserved: need, remaining: debited.quota, replayed: false }
	})
}

async function complete(
	identity: Pick<Identity, "userId" | "tokenId">,
	requestId: string,
	actual: number,
	kind: "settle" | "release",
): Promise<SettleResult & { refunded: number }> {
	const charge = quotaAmount(actual, "charge")
	return transaction(async (db) => {
		const journal = db.collection<QuotaJournalDoc>(COLLECTIONS.quotaJournal)
		const reservation = await journal.findOne({
			_id: requestId, userId: identity.userId, tokenId: identity.tokenId,
		})
		const account = db.collection<UserDoc>(COLLECTIONS.users)
		const user = await account.findOne({ _id: identity.userId })
		if (!reservation || reservation.state !== "pending") {
			return { applied: false, remaining: user?.quota ?? 0, refunded: 0 }
		}
		if (!user) throw ledgerUnavailable()
		const delta = reservation.reserved - charge
		if (!Number.isSafeInteger(user.quota + delta) || !Number.isSafeInteger(user.usedQuota + charge)) {
			throw ledgerUnavailable()
		}
		const updated = await account.findOneAndUpdate(
			{ _id: user._id },
			{
				$inc: { quota: delta, usedQuota: charge, requestCount: kind === "settle" ? 1 : 0 },
				$set: { updatedAt: new Date() },
			},
		)
		if (!updated) throw ledgerUnavailable()
		// Deleting a key while inference runs cannot cancel its owner's bill.
		await db.collection<TokenDoc>(COLLECTIONS.tokens).updateOne(
			{ _id: identity.tokenId, userId: identity.userId },
			{ $inc: { ...(reservation.tokenLimited ? { quota: delta } : {}), usedQuota: charge } },
		)
		await journal.updateOne(
			{ _id: requestId, state: "pending" },
			{ $set: { kind, amount: charge, state: "applied", appliedAt: new Date() } },
		)
		return { applied: true, remaining: updated.quota, refunded: kind === "release" ? reservation.reserved : 0 }
	})
}

export async function settleQuota(identity: Identity, requestId: string, actual: number): Promise<SettleResult> {
	return complete(identity, requestId, actual, "settle")
}

export async function releaseQuota(identity: Identity, requestId: string): Promise<{ released: boolean; refunded: number }> {
	try {
		const result = await complete(identity, requestId, 0, "release")
		return { released: result.applied, refunded: result.refunded }
	} catch (error) {
		if (!GatewayError.is(error) || error.status !== 503) throw error
		await redisCommand(["RPUSH", K.quotaSettlementBuffer(), JSON.stringify({
			requestId, userId: identity.userId, tokenId: identity.tokenId, actual: 0,
		})])
		return { released: false, refunded: 0 }
	}
}

export async function finalizeQuota(identity: Identity, requestId: string, actual: number): Promise<SettleResult> {
	quotaAmount(actual, "charge")
	try {
		return await complete(identity, requestId, actual, actual === 0 ? "release" : "settle")
	} catch (error) {
		if (!GatewayError.is(error) || error.status !== 503) throw error
		// The durable hold already exists. Preserve the measured settlement in
		// the independent shared store for replay after Mongo recovers.
		await redisCommand(["RPUSH", K.quotaSettlementBuffer(), JSON.stringify({
			requestId, userId: identity.userId, tokenId: identity.tokenId, actual,
		})])
		return { applied: false, remaining: 0 }
	}
}

export async function currentBalance(identity: Identity): Promise<number> {
	return hydrateUserQuota(identity.userId)
}

/** Peek/commit/owner-checked-ack; a crash at any step is safe to replay. */
export async function flushQuotaSettlements(limit = 100): Promise<number> {
	const lock = K.lock("quota-settlements")
	const owner = randomHex(16)
	if (!await redisSetNx(lock, owner, 120)) return 0
	try {
		const raw = await redisCommand(["LRANGE", K.quotaSettlementBuffer(), 0, Math.max(1, Math.min(1000, limit)) - 1])
		if (!Array.isArray(raw) || !raw.length) return 0
		for (const item of raw) {
			const entry = JSON.parse(String(item)) as { requestId: string; userId: string; tokenId: string; actual: number }
			if (!entry.requestId || !entry.userId || !entry.tokenId) throw ledgerUnavailable()
			await complete(entry, entry.requestId, entry.actual, entry.actual === 0 ? "release" : "settle")
		}
		await runScript("ackUsage", [K.quotaSettlementBuffer(), lock], [owner, raw.length])
		return raw.length
	} finally {
		await runScript("releaseLock", [lock], [owner]).catch(() => {})
	}
}
