/**
 * Explicit v1 -> v2 migration. Never infer a missing hot balance from stale
 * Mongo fields. Export, reconcile against receipts, review, then apply with all
 * old traffic/cron jobs stopped. This module never runs automatically.
 */
import type { Database } from "../db/driver.ts"
import type { UserDoc, TokenDoc } from "../db/types.ts"
import { COLLECTIONS } from "../db/types.ts"
import { redisGet } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import { QUOTA_LEDGER_VERSION } from "./index.ts"

export type BalanceRow = {
	kind: "user" | "token"
	id: string
	/** Null means unavailable; an operator must reconcile it, never assume zero. */
	remaining: number | null
	usedQuota: number
	previousMongoQuota: number
}
export type BalancePlan = { version: 2; createdAt: string; reviewed: boolean; balances: BalanceRow[] }

export async function exportBalancePlan(db: Database): Promise<BalancePlan> {
	const balances: BalanceRow[] = []
	for (const kind of ["user", "token"] as const) {
		const collection = db.collection<UserDoc | TokenDoc>(kind === "user" ? COLLECTIONS.users : COLLECTIONS.tokens)
		let after = ""
		for (;;) {
			const rows = await collection.find(
				{ quotaLedgerVersion: { $ne: QUOTA_LEDGER_VERSION }, ...(after ? { _id: { $gt: after } } : {}) },
				{ sort: { _id: 1 }, limit: 200 },
			)
			for (const row of rows) {
				const raw = await redisGet(kind === "user" ? K.userQuota(row._id) : K.tokenQuota(row._id))
				const parsed = raw === null || !/^-?\d+$/.test(raw) ? null : Number(raw)
				balances.push({
					kind, id: row._id, remaining: Number.isSafeInteger(parsed) ? parsed : null,
					usedQuota: row.usedQuota, previousMongoQuota: row.quota,
				})
			}
			if (rows.length < 200) break
			after = rows[rows.length - 1]._id
		}
	}
	return { version: 2, createdAt: new Date().toISOString(), reviewed: false, balances }
}

export async function applyBalancePlan(db: Database, plan: BalancePlan): Promise<number> {
	if (plan.version !== 2 || plan.reviewed !== true || !Array.isArray(plan.balances)) {
		throw new Error("a reviewed version-2 balance plan is required")
	}
	const seen = new Set<string>()
	for (const row of plan.balances) {
		const key = `${row.kind}:${row.id}`
		if (!["user", "token"].includes(row.kind) || !row.id || seen.has(key) ||
			!Number.isSafeInteger(row.remaining) || !Number.isSafeInteger(row.usedQuota) || row.usedQuota < 0 ||
			!Number.isSafeInteger(row.previousMongoQuota)) {
			throw new Error("invalid, duplicate, or unreconciled balance row")
		}
		seen.add(key)
	}
	let applied = 0
	for (const row of plan.balances) {
		applied += await db.transaction(async (tx) => {
			const collection = tx.collection<UserDoc | TokenDoc>(row.kind === "user" ? COLLECTIONS.users : COLLECTIONS.tokens)
			const current = await collection.findOne({ _id: row.id })
			if (!current) throw new Error("a planned account or key no longer exists")
			if (current.quotaLedgerVersion === QUOTA_LEDGER_VERSION) return 0
			if (current.quota !== row.previousMongoQuota) throw new Error("balance changed after export; stop traffic and re-export")
			await collection.updateOne({ _id: row.id }, { $set: {
				quota: row.remaining, usedQuota: row.usedQuota, quotaLedgerVersion: QUOTA_LEDGER_VERSION,
				...(row.kind === "user" ? { legacyUsedQuota: row.usedQuota } : {}), updatedAt: new Date(),
			} })
			return 1
		})
	}
	return applied
}