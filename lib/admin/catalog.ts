/**
 * Pricing, model mappings, group ratios, redemption codes, settings, and the
 * read-only reporting the console needs.
 *
 * Two notes worth keeping in mind while reading:
 *
 *  - Pricing is only ever written from here, never fetched from a third party
 *    at request time (GW-029). A poisoned price is a billing bug that looks
 *    like a discount, so the operator has to type it.
 *  - Redemption codes are stored as digests with a 4-character prefix for
 *    support (GW-020). The single-use claim is an atomic conditional update,
 *    so two concurrent redemptions of the same code cannot both win.
 */

import { config } from "../config/env.ts"
import {
	auditLogs,
	groupRatios,
	modelMappings,
	modelPricing,
	redemptionCodes,
	settings,
	usageLogs,
	usageRollups,
	users,
} from "../db/index.ts"
import type {
	AuditLogDoc,
	GroupRatioDoc,
	ModelMappingDoc,
	ModelPricingDoc,
	RedemptionCodeDoc,
	UsageLogDoc,
	UsageRollupDoc,
} from "../db/types.ts"
import { invalidRequest, notFound } from "../http/errors.ts"
import { K } from "../redis/keys.ts"
import { redisDel, redisGetJson, redisSetJson } from "../redis/client.ts"
import { invalidateAbilities } from "../routing/abilities.ts"
import { PRICING_VERSION, normalizeModelName, quotaToUsd } from "../pricing/index.ts"
import { randomAlphanumeric, randomHex, sha256Hex } from "../util/crypto.ts"
import { monthBucket } from "../util/time.ts"

function positive(value: unknown, field: string): number {
	const parsed = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw invalidRequest(`${field} must be a non-negative number`, field)
	}
	return parsed
}

function optionalPositive(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined
	return positive(value, field)
}

function name(value: unknown, field: string, max = 200): string {
	if (typeof value !== "string" || !value.trim()) throw invalidRequest(`${field} is required`, field)
	if (value.length > max) throw invalidRequest(`${field} is too long`, field)
	return value.trim()
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Mirrors the key built in lib/pricing/index.ts.
 *
 * Worth stating plainly because it is an easy bug to write: `K.pricing()` is
 * keyed by pricing *version*, not by model. The model name is a suffix. Using
 * `K.pricing(model)` would delete a key nothing ever wrote, so a price edit
 * would appear to succeed and then not take effect until the TTL expired.
 */
function pricingCacheKey(model: string): string {
	return `${K.pricing(PRICING_VERSION)}:${normalizeModelName(model)}`
}

export async function listPricing(): Promise<ModelPricingDoc[]> {
	return await (await modelPricing()).find({}, { limit: 500 })
}

export async function upsertPricing(input: Record<string, unknown>): Promise<ModelPricingDoc> {
	const model = name(input.model ?? input._id, "model")
	const doc: Record<string, unknown> = {
		modelRatio: positive(input.modelRatio, "modelRatio"),
		completionRatio: positive(input.completionRatio, "completionRatio"),
	}
	for (const field of [
		"cachedRatio",
		"cacheWrite5mRatio",
		"cacheWrite1hRatio",
		"imageRatio",
		"audioRatio",
		"audioCompletionRatio",
		"perCallQuota",
	]) {
		const value = optionalPositive(input[field], field)
		if (value !== undefined) doc[field] = value
	}

	await (await modelPricing()).updateOne({ _id: model }, { $set: doc }, true)
	// Drop the cached price so the next request bills at the new rate.
	await redisDel(pricingCacheKey(model))
	const saved = await (await modelPricing()).findOne({ _id: model })
	if (!saved) throw notFound("pricing row disappeared immediately after write")
	return saved
}

export async function deletePricing(model: string): Promise<void> {
	await (await modelPricing()).deleteOne({ _id: model })
	await redisDel(pricingCacheKey(model))
}

// ---------------------------------------------------------------------------
// Model mappings and group ratios
// ---------------------------------------------------------------------------

export async function listMappings(): Promise<ModelMappingDoc[]> {
	return await (await modelMappings()).find({}, { limit: 500 })
}

export async function upsertMapping(input: Record<string, unknown>): Promise<ModelMappingDoc> {
	const from = name(input.from, "from")
	const to = name(input.to, "to")
	const channelId =
		typeof input.channelId === "string" && input.channelId.trim()
			? input.channelId.trim()
			: undefined
	const id = channelId ? `${channelId}:${from}` : from
	const doc: ModelMappingDoc = {
		_id: id,
		from,
		to,
		createdAt: new Date(),
	}
	if (channelId) doc.channelId = channelId
	await (await modelMappings()).updateOne({ _id: id }, { $set: doc }, true)
	await invalidateAbilities()
	return doc
}

export async function deleteMapping(id: string): Promise<void> {
	await (await modelMappings()).deleteOne({ _id: id })
	await invalidateAbilities()
}

export async function listGroupRatios(): Promise<GroupRatioDoc[]> {
	return await (await groupRatios()).find({}, { limit: 200 })
}

export async function upsertGroupRatio(input: Record<string, unknown>): Promise<GroupRatioDoc> {
	const group = name(input.group ?? input._id, "group", 64)
	const ratio = positive(input.ratio, "ratio")
	const doc: GroupRatioDoc = { _id: group, ratio, updatedAt: new Date() }
	if (typeof input.description === "string") doc.description = input.description.slice(0, 500)
	await (await groupRatios()).updateOne({ _id: group }, { $set: doc }, true)
	return doc
}

// ---------------------------------------------------------------------------
// Redemption codes
// ---------------------------------------------------------------------------

const CODE_LENGTH = 20
const MAX_BATCH = 500
const MAX_REDEEM_ATTEMPTS = 10

function codeDigestFor(code: string): Promise<string> {
	return sha256Hex(`redeem:${code}`)
}

export async function createRedemptionBatch(input: {
	count: number
	quota: number
	createdBy: string
	expiresAt?: Date | null
}): Promise<{ batchId: string; codes: string[] }> {
	const count = Math.min(Math.max(Math.floor(input.count), 1), MAX_BATCH)
	const quota = positive(input.quota, "quota")
	const batchId = randomHex(8)
	const docs: RedemptionCodeDoc[] = []
	const codes: string[] = []

	for (let index = 0; index < count; index += 1) {
		// ~103 bits of entropy. Guessing is not the attack to worry about; the
		// attempt cap below exists so the endpoint cannot be used as an oracle.
		const code = randomAlphanumeric(CODE_LENGTH).toUpperCase()
		codes.push(code)
		const doc: RedemptionCodeDoc = {
			_id: randomHex(12),
			codeDigest: await codeDigestFor(code),
			codePrefix: code.slice(0, 4),
			quota,
			status: "unused",
			batchId,
			createdBy: input.createdBy,
			createdAt: new Date(),
		}
		if (input.expiresAt) doc.expiresAt = input.expiresAt
		docs.push(doc)
	}

	await (await redemptionCodes()).insertMany(docs)
	// The plaintext codes exist only in this return value.
	return { batchId, codes }
}

export async function listRedemptionCodes(
	batchId?: string,
): Promise<Array<Omit<RedemptionCodeDoc, "codeDigest">>> {
	const filter = batchId ? { batchId } : {}
	const rows = await (await redemptionCodes()).find(filter, { limit: 500 })
	return rows.map((row) => {
		const { codeDigest: _digest, ...rest } = row
		return rest
	})
}

/**
 * Claims a code for a user.
 *
 * The claim is a conditional update on `status: "unused"`, so if two requests
 * race, exactly one of them sees a document come back and the other sees null.
 * Only after winning that race do we credit the account.
 */
export async function redeemCode(
	rawCode: string,
	userId: string,
): Promise<{ quota: number; balance: number }> {
	const code = name(rawCode, "code", 64)
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")

	const attemptKey = K.redeemAttempts(userId)
	const attempts = (await redisGetJson<{ n: number }>(attemptKey))?.n ?? 0
	if (attempts >= MAX_REDEEM_ATTEMPTS) {
		throw invalidRequest("too many redemption attempts, try again later", "code")
	}

	const digest = await codeDigestFor(code)
	const claimed = await (await redemptionCodes()).findOneAndUpdate(
		{ codeDigest: digest, status: "unused" },
		{ $set: { status: "used", usedBy: userId, usedAt: new Date() } },
	)

	if (!claimed) {
		await redisSetJson(attemptKey, { n: attempts + 1 }, 3600)
		// Deliberately identical for "never existed", "already used", and
		// "disabled": the response must not confirm a guess.
		throw invalidRequest("that code is not valid", "code")
	}

	if (claimed.expiresAt && new Date(claimed.expiresAt).getTime() < Date.now()) {
		// Put it back so an expired code is not silently consumed.
		await (await redemptionCodes()).updateOne(
			{ _id: claimed._id },
			{ $set: { status: "unused", usedBy: null, usedAt: null } },
		)
		throw invalidRequest("that code is not valid", "code")
	}

	await (await users()).updateOne({ _id: userId }, { $inc: { quota: claimed.quota } })
	// The balance is cached in Redis, so drop it or the credit is invisible.
	await redisDel(K.userQuota(userId))
	const user = await (await users()).findOne({ _id: userId })
	return { quota: claimed.quota, balance: user?.quota ?? claimed.quota }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
	const row = await (await settings()).findOne({ _id: key })
	if (!row) return fallback
	return (row.value as T) ?? fallback
}

export async function setSetting(key: string, value: unknown): Promise<void> {
	await (await settings()).updateOne(
		{ _id: name(key, "key", 120) },
		{ $set: { value, updatedAt: new Date() } },
		true,
	)
}

export async function listSettings(): Promise<Array<{ key: string; value: unknown }>> {
	const rows = await (await settings()).find({}, { limit: 200 })
	return rows.map((row) => ({ key: row._id, value: row.value }))
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export type UsageSummary = {
	bucketPrefix: string
	requests: number
	errors: number
	quota: number
	usd: number
	promptTokens: number
	completionTokens: number
	topModels: Array<{ model: string; requests: number; quota: number }>
}

/**
 * Summarises the rollup collection. The driver here has no aggregation
 * pipeline, so the arithmetic happens in process -- which is fine, because the
 * rollups are already one row per scope per hour.
 */
export async function usageSummary(bucketPrefix = monthBucket()): Promise<UsageSummary> {
	const rows = await (await usageRollups()).find({}, { limit: 5000 })
	const summary: UsageSummary = {
		bucketPrefix,
		requests: 0,
		errors: 0,
		quota: 0,
		usd: 0,
		promptTokens: 0,
		completionTokens: 0,
		topModels: [],
	}

	const byModel = new Map<string, { requests: number; quota: number }>()
	for (const row of rows as UsageRollupDoc[]) {
		if (!String(row.bucket).startsWith(bucketPrefix.slice(0, 6))) continue
		if (row.scope === "model") {
			const entry = byModel.get(row.key) ?? { requests: 0, quota: 0 }
			entry.requests += row.requests
			entry.quota += row.quota
			byModel.set(row.key, entry)
		}
		// Count totals from a single scope so nothing is counted twice.
		if (row.scope !== "user") continue
		summary.requests += row.requests
		summary.errors += row.errors
		summary.quota += row.quota
		summary.promptTokens += row.promptTokens
		summary.completionTokens += row.completionTokens
	}

	summary.usd = quotaToUsd(summary.quota)
	summary.topModels = [...byModel.entries()]
		.map(([model, entry]) => ({ model, ...entry }))
		.sort((left, right) => right.quota - left.quota)
		.slice(0, 10)
	return summary
}

export type UsageQuery = {
	userId?: string
	tokenId?: string
	channelId?: string
	model?: string
	status?: string
	limit?: number
	skip?: number
	bucket?: string
}

export async function listUsage(query: UsageQuery = {}): Promise<UsageLogDoc[]> {
	const filter: Record<string, unknown> = {}
	for (const field of ["userId", "tokenId", "channelId", "model", "status"] as const) {
		const value = query[field]
		if (value) filter[field] = value
	}
	const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200)
	const skip = Math.max(Math.floor(query.skip ?? 0), 0)
	const collection = await usageLogs(query.bucket || monthBucket())
	return await collection.find(filter, { sort: { createdAt: -1 }, limit, skip })
}

export async function listAudit(
	options: { limit?: number; skip?: number } = {},
): Promise<AuditLogDoc[]> {
	const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200)
	const skip = Math.max(Math.floor(options.skip ?? 0), 0)
	return await (await auditLogs()).find({}, { sort: { createdAt: -1 }, limit, skip })
}

/** Everything the console's overview screen needs, in one round trip. */
export async function consoleOverview(): Promise<Record<string, unknown>> {
	const summary = await usageSummary()
	return {
		summary,
		siteName: config.siteName,
		quotaPerUnit: config.quotaPerUnit,
		month: monthBucket(),
	}
}
