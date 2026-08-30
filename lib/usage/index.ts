/**
 * The usage ledger.
 *
 * Every completed request produces one row. It is the record used for billing
 * disputes, so two properties matter more than throughput:
 *
 *   - Exactly one row per request. The row id is the request id, so a retried
 *     flush overwrites the same document instead of charging twice.
 *   - No raw client address, ever (GW-024). Only the HMAC arrives here.
 *
 * Writes are buffered through Redis because a serverless invocation should not
 * wait on a second database round trip after the response has been streamed.
 * The buffer is drained by a cron; if Redis is unavailable the write falls
 * straight through to Mongo, since losing billing data is worse than being
 * slow.
 */

import { usageLogs, usageRollups } from "../db/index.ts"
import type { UsageLogDoc } from "../db/types.ts"
import { redisCommand, redisPipeline } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import { monthBucket } from "../util/time.ts"
import { EMPTY_USAGE } from "./measure.ts"
import type { NormalizedUsage } from "./measure.ts"

export type UsageRecordInput = {
	requestId: string
	userId: string
	tokenId: string
	channelId: string
	group: string
	model: string
	mappedModel: string
	billedModel: string
	endpoint: string
	dialect: string
	stream: boolean
	usage?: NormalizedUsage
	quota: number
	elapsedMs: number
	firstByteMs?: number
	retries?: number
	status: "success" | "error" | "aborted"
	errorCode?: string
	httpStatus: number
	/** Already hashed by the caller. A raw address here would be a defect. */
	ipHash: string
	createdAt?: Date
}

function round(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** The ISO hour a rollup is bucketed into, e.g. 2026-08-30T21. */
export function hourBucket(date: Date = new Date()): string {
	return date.toISOString().slice(0, 13)
}

/**
 * Builds the row. Pure, so the mapping can be checked without a database.
 *
 * The id is the request id rather than a random value: that is what makes the
 * whole pipeline replay-safe.
 */
export function buildUsageLog(input: UsageRecordInput): UsageLogDoc {
	const usage = input.usage ?? EMPTY_USAGE
	return {
		_id: input.requestId,
		requestId: input.requestId,
		userId: input.userId,
		tokenId: input.tokenId,
		channelId: input.channelId,
		group: input.group,
		model: input.model,
		mappedModel: input.mappedModel,
		billedModel: input.billedModel,
		endpoint: input.endpoint,
		dialect: input.dialect,
		stream: input.stream,
		promptTokens: round(usage.promptTokens),
		completionTokens: round(usage.completionTokens),
		cachedTokens: round(usage.cachedTokens),
		cacheWrite5mTokens: round(usage.cacheWrite5mTokens),
		cacheWrite1hTokens: round(usage.cacheWrite1hTokens),
		imageTokens: round(usage.imageTokens),
		audioPromptTokens: round(usage.audioPromptTokens),
		audioCompletionTokens: round(usage.audioCompletionTokens),
		reasoningTokens: round(usage.reasoningTokens),
		toolCalls: usage.toolCalls ?? {},
		quota: round(input.quota),
		elapsedMs: round(input.elapsedMs),
		firstByteMs: round(input.firstByteMs),
		retries: round(input.retries),
		status: input.status,
		...(input.errorCode ? { errorCode: input.errorCode } : {}),
		httpStatus: round(input.httpStatus),
		ipHash: input.ipHash,
		createdAt: input.createdAt ?? new Date(),
	}
}

/**
 * Records usage.
 *
 * @param options.buffered route through Redis (the default). Set false when
 *   the caller needs the row to be durable before it returns.
 */
export async function recordUsage(
	input: UsageRecordInput,
	options: { buffered?: boolean } = {},
): Promise<void> {
	const doc = buildUsageLog(input)
	const buffered = options.buffered ?? true

	if (buffered) {
		try {
			await redisCommand(["RPUSH", K.usageBuffer(), JSON.stringify(doc)])
			return
		} catch {
			// Fall through: a buffering failure must not lose the row.
		}
	}
	await persist([doc])
}

/**
 * Writes rows to their monthly collection.
 *
 * Upserted on the request id so a redelivered row is not a second charge. The
 * id is excluded from the update because it is immutable and already matched
 * by the filter.
 */
export async function persist(docs: UsageLogDoc[]): Promise<number> {
	if (docs.length === 0) return 0

	// Rows can straddle a month boundary during a flush.
	const byBucket = new Map<string, UsageLogDoc[]>()
	for (const doc of docs) {
		const bucket = monthBucket(new Date(doc.createdAt))
		const list = byBucket.get(bucket)
		if (list) list.push(doc)
		else byBucket.set(bucket, [doc])
	}

	let written = 0
	for (const [bucket, rows] of byBucket) {
		const collection = await usageLogs(bucket)
		for (const doc of rows) {
			const { _id, ...rest } = doc
			await collection.updateOne({ _id }, { $set: rest }, true)
			written++
		}
	}

	await applyRollups(docs)
	return written
}

/**
 * Drains the buffer into Mongo.
 *
 * Entries are popped one at a time in a single pipeline. Reading a range and
 * trimming it afterwards would be fewer commands but would drop rows whenever
 * two flushes overlap, which for a billing ledger is the wrong trade.
 */
export async function flushUsageBuffer(limit = 500): Promise<number> {
	const size = Math.max(1, Math.min(limit, 1000))
	let raw: unknown[] = []
	try {
		raw = await redisPipeline(Array.from({ length: size }, () => ["LPOP", K.usageBuffer()]))
	} catch {
		return 0
	}

	const docs: UsageLogDoc[] = []
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.length === 0) continue
		try {
			const parsed = JSON.parse(entry) as UsageLogDoc
			if (parsed && typeof parsed._id === "string") docs.push(parsed)
		} catch {
			// A corrupt entry is dropped rather than stalling the whole drain.
		}
	}

	if (docs.length === 0) return 0

	try {
		return await persist(docs)
	} catch (error) {
		// Put them back so the next run retries. Upserting on the request id
		// means a partial write followed by a replay is still one charge.
		try {
			await redisCommand(["RPUSH", K.usageBuffer(), ...docs.map((d) => JSON.stringify(d))])
		} catch {
			// Nothing further can be done here; the error propagates.
		}
		throw error
	}
}

/** How many rows are waiting to be written. */
export async function pendingUsageCount(): Promise<number> {
	try {
		const raw = await redisCommand(["LLEN", K.usageBuffer()])
		const n = Number(raw)
		return Number.isFinite(n) && n > 0 ? n : 0
	} catch {
		return 0
	}
}

/**
 * Accumulates hourly totals for the console.
 *
 * Rollups are a convenience, not the ledger, so a failure here is swallowed -
 * the authoritative rows are already written and can be re-aggregated.
 */
export async function applyRollups(docs: UsageLogDoc[]): Promise<void> {
	if (docs.length === 0) return
	try {
		const collection = await usageRollups()
		for (const doc of docs) {
			const bucket = hourBucket(new Date(doc.createdAt))
			const scopes: Array<{ scope: "user" | "channel" | "model" | "global"; key: string }> = [
				{ scope: "user", key: doc.userId },
				{ scope: "channel", key: doc.channelId },
				{ scope: "model", key: doc.billedModel },
				{ scope: "global", key: "all" },
			]
			for (const { scope, key } of scopes) {
				if (!key) continue
				await collection.updateOne(
					{ _id: `${scope}:${key}:${bucket}` },
					{
						$inc: {
							requests: 1,
							errors: doc.status === "success" ? 0 : 1,
							quota: doc.quota,
							promptTokens: doc.promptTokens,
							completionTokens: doc.completionTokens,
						},
						$set: { scope, key, bucket, updatedAt: new Date() },
					},
					true,
				)
			}
		}
	} catch {
		// Derived data only.
	}
}

export { addUsage, detectUsageShape, EMPTY_USAGE, maxUsage, normalizeUsage } from "./measure.ts"
export type { NormalizedUsage } from "./measure.ts"
export { billedModelFor, computeQuota, quotaFor, quotaToUsd } from "./billing.ts"
export type { QuotaBreakdown } from "./billing.ts"
