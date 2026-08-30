/**
 * The scheduled jobs.
 *
 * Each one is written to be safe to run twice, safe to run late, and bounded
 * in how much work it will attempt in a single invocation - a serverless cron
 * that tries to process everything eventually meets a month of data and times
 * out halfway through, leaving the tail permanently unprocessed.
 */

import { config } from "../config/env.ts"
import {
	channels,
	getDb,
	modelPricing,
	tokens,
	usageRollups,
	users,
} from "../db/index.ts"
import { ensureIndexes } from "../db/indexes.ts"
import { flushUsageBuffer, pendingUsageCount } from "../usage/index.ts"
import { getModelPricing } from "../pricing/index.ts"
import { pickChannelKey } from "../routing/keys.ts"
import { recordChannelOutcome } from "../routing/health.ts"
import { rebuildAbilities } from "../routing/abilities.ts"
import { upstreamFetch } from "../upstream/fetch.ts"
import { buildUpstreamHeaders } from "../http/headers.ts"
import { dialectFor, providerAuthHeaders, transformRequest, upstreamUrlFor } from "../transform/index.ts"
import { monthBucket } from "../util/time.ts"

/**
 * Moves buffered usage rows into MongoDB.
 *
 * Usage is buffered in Redis so that settling a request never waits on a
 * database write. That trade is only sound if the buffer is drained promptly,
 * which is what this job is for.
 */
export async function flushUsage(): Promise<Record<string, unknown>> {
	let flushed = 0
	// Bounded: a runaway backlog is drained across invocations, not in one.
	for (let pass = 0; pass < 20; pass++) {
		const moved = await flushUsageBuffer(500)
		flushed += moved
		if (moved === 0) break
	}
	return { flushed, pending: await pendingUsageCount() }
}

/** Drains the buffer, then reports the current month's totals. */
export async function rollupUsage(): Promise<Record<string, unknown>> {
	const drained = await flushUsage()
	const bucketPrefix = monthBucket()
	const rows = await (await usageRollups()).find({ scope: "user" })

	let requests = 0
	let errors = 0
	let quota = 0
	for (const row of rows) {
		if (typeof row.bucket !== "string" || !row.bucket.startsWith(bucketPrefix.slice(0, 4))) continue
		requests += Number(row.requests) || 0
		errors += Number(row.errors) || 0
		quota += Number(row.quota) || 0
	}
	return { ...drained, accounts: rows.length, requests, errors, quota }
}

/**
 * Recomputes each account's spend from the ledger.
 *
 * `users.usedQuota` is a denormalised total kept for fast reads. Denormalised
 * totals drift - a crash between the ledger write and the counter update is
 * all it takes - so the rollups, which are derived from the usage rows
 * themselves, are treated as the truth and the counter is corrected to match.
 */
export async function reconcileQuota(): Promise<Record<string, unknown>> {
	const rows = await (await usageRollups()).find({ scope: "user" })
	const spentByUser = new Map<string, number>()
	for (const row of rows) {
		const key = String(row.key ?? "")
		if (key === "") continue
		spentByUser.set(key, (spentByUser.get(key) ?? 0) + (Number(row.quota) || 0))
	}

	const collection = await users()
	const drifted: Array<{ userId: string; was: number; now: number }> = []
	for (const [userId, spent] of spentByUser) {
		const user = await collection.findOne({ _id: userId })
		if (!user) continue
		const recorded = Number(user.usedQuota) || 0
		if (recorded === spent) continue
		drifted.push({ userId, was: recorded, now: spent })
		await collection.updateOne({ _id: userId }, { $set: { usedQuota: spent, updatedAt: new Date() } })
	}
	return { examined: spentByUser.size, corrected: drifted.length, drifted: drifted.slice(0, 25) }
}

/** Disables tokens whose expiry has passed. */
export async function expireTokens(): Promise<Record<string, unknown>> {
	const collection = await tokens()
	const now = Date.now()
	const enabled = await collection.find({ status: "enabled" })

	let expired = 0
	for (const token of enabled) {
		const expiresAt = token.expiresAt
		if (!expiresAt) continue
		if (new Date(expiresAt as Date).getTime() > now) continue
		await collection.updateOne(
			{ _id: token._id },
			{ $set: { status: "disabled", updatedAt: new Date() } },
		)
		expired++
	}
	return { examined: enabled.length, expired }
}

/** Derives next month's bucket from this one so the format cannot drift. */
function followingBucket(current: string): string {
	const year = Number(current.slice(0, 4))
	const month = Number(current.slice(4, 6))
	if (!Number.isFinite(year) || !Number.isFinite(month)) return current
	// `month` is 1-based, so passing it as a 0-based index lands on next month.
	const next = new Date(Date.UTC(year, month, 1))
	return `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}`
}

/**
 * Creates next month's usage collection and its indexes before anything
 * writes to it. An index built on a collection that is already receiving
 * traffic is a latency spike; built on an empty one it is free.
 */
export async function partitionMaintenance(): Promise<Record<string, unknown>> {
	const db = await getDb()
	const current = monthBucket()
	const buckets = [current, followingBucket(current)]
	const created = await ensureIndexes(db, buckets)
	return { buckets, indexes: created.length }
}

/**
 * Probes every enabled channel with a one-token request.
 *
 * The result feeds the same circuit breaker that live traffic uses, so a
 * channel that recovers overnight is back in rotation before a user finds it,
 * and one that died quietly is opened out before it costs anyone a retry.
 */
export async function healthCheck(): Promise<Record<string, unknown>> {
	const enabled = await (await channels()).find({ status: "enabled" })
	const results: Array<{ channelId: string; ok: boolean; detail?: string }> = []
	const limit = Math.max(1, config.channelTestConcurrency)

	async function probe(channel: Record<string, unknown>): Promise<void> {
		const channelId = String(channel._id)
		const model =
			(typeof channel.testModel === "string" && channel.testModel !== ""
				? channel.testModel
				: Array.isArray(channel.models) && typeof channel.models[0] === "string"
					? channel.models[0]
					: config.channelTestModel) || config.channelTestModel

		if (model === "") {
			results.push({ channelId, ok: false, detail: "no test model configured" })
			return
		}

		try {
			const key = await pickChannelKey(channelId)
			const wire = dialectFor(channel.type as string)
			const body = transformRequest({
				from: "openai",
				to: wire,
				body: { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
				model,
			})
			const url = upstreamUrlFor(channel as never, { endpoint: "chat", model, stream: false })
			const headers = buildUpstreamHeaders({
				clientHeaders: new Headers(),
				authHeaders: providerAuthHeaders(channel.type as string, key.secret),
				channelHeaders: (channel.headers as Record<string, string>) ?? {},
				contentType: "application/json",
			})

			const response = await upstreamFetch(
				url,
				{ method: "POST", headers, body: JSON.stringify(body) },
				{ headerTimeoutMs: 10_000, maxBytes: 64 * 1024 },
			)
			const ok = response.ok
			await recordChannelOutcome(channelId, ok)
			results.push({ channelId, ok, detail: ok ? undefined : `status ${response.status}` })
		} catch (error) {
			await recordChannelOutcome(channelId, false).catch(() => {})
			results.push({
				channelId,
				ok: false,
				detail: error instanceof Error ? error.message : "probe failed",
			})
		}
	}

	for (let i = 0; i < enabled.length; i += limit) {
		await Promise.all(enabled.slice(i, i + limit).map((channel) => probe(channel)))
	}

	// Routing reads a denormalised ability table; refresh it while we are here.
	await rebuildAbilities().catch(() => {})

	return {
		probed: results.length,
		healthy: results.filter((r) => r.ok).length,
		results: results.slice(0, 50),
	}
}

/**
 * Warms the pricing cache and reports models with no explicit price.
 *
 * Deliberately does not import prices from a remote source. A gateway that
 * repriced itself from a URL would let whoever controls that URL set every
 * customer's bill to zero, or to a hundred times cost (GW-029). Prices change
 * through an audited admin write, not a scheduled fetch.
 */
export async function refreshPricing(): Promise<Record<string, unknown>> {
	const enabled = await (await channels()).find({ status: "enabled" })
	const names = new Set<string>()
	for (const channel of enabled) {
		for (const model of Array.isArray(channel.models) ? channel.models : []) {
			if (typeof model === "string" && model !== "") names.add(model)
		}
	}

	const explicit = new Set<string>()
	for (const row of await (await modelPricing()).find({})) explicit.add(String(row._id))

	let warmed = 0
	for (const model of names) {
		await getModelPricing(model).catch(() => undefined)
		warmed++
	}

	const missing = [...names].filter((model) => !explicit.has(model)).sort()
	return { warmed, explicit: explicit.size, usingDefaults: missing.length, models: missing.slice(0, 50) }
}
