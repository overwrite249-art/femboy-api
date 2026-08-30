/**
 * Index catalogue.
 *
 * Indexes are not an optimisation detail here - several of them are the
 * enforcement mechanism for a security property:
 *
 *  - `tokens.keyDigest` unique  : one key cannot be registered twice
 *  - `quota_journal` unique     : billing settlement is exactly-once (GW-009)
 *  - `usage_logs.requestId`     : replayed usage rows cannot double-charge
 *  - `redemption_codes` unique  : a code can be consumed once (GW-020)
 *  - TTL on `oauth_states`      : CSRF states expire without a sweeper
 */

import { COLLECTIONS, usageCollectionName } from "./types.ts"
import type { Database, IndexSpec } from "./driver.ts"

export const INDEXES: Record<string, IndexSpec[]> = {
	[COLLECTIONS.users]: [
		{ key: { username: 1 }, name: "uniq_username", unique: true },
		{ key: { email: 1 }, name: "uniq_email", unique: true, sparse: true },
		{ key: { githubId: 1 }, name: "uniq_github", unique: true, sparse: true },
		{ key: { status: 1, role: 1 }, name: "status_role" },
		{ key: { affCode: 1 }, name: "uniq_aff", unique: true, sparse: true },
	],
	[COLLECTIONS.tokens]: [
		{ key: { keyPrefix: 1 }, name: "uniq_key_prefix", unique: true },
		{ key: { keyDigest: 1 }, name: "uniq_key_digest", unique: true },
		{ key: { userId: 1, status: 1 }, name: "owner_status" },
		{ key: { expiresAt: 1 }, name: "expiry", sparse: true },
	],
	[COLLECTIONS.channels]: [
		{ key: { status: 1, priority: -1 }, name: "status_priority" },
		{ key: { type: 1 }, name: "type" },
		{ key: { name: 1 }, name: "uniq_name", unique: true },
	],
	[COLLECTIONS.channelKeys]: [
		{ key: { channelId: 1, index: 1 }, name: "uniq_channel_index", unique: true },
		{ key: { channelId: 1, status: 1 }, name: "channel_status" },
		{ key: { fingerprint: 1 }, name: "fingerprint" },
	],
	[COLLECTIONS.abilities]: [
		{
			key: { group: 1, model: 1, enabled: 1, priority: -1, weight: -1 },
			name: "routing_lookup",
		},
		{ key: { channelId: 1 }, name: "by_channel" },
	],
	[COLLECTIONS.modelPricing]: [{ key: { updatedAt: -1 }, name: "freshness" }],
	[COLLECTIONS.modelMappings]: [
		{ key: { from: 1, channelId: 1 }, name: "uniq_mapping", unique: true },
	],
	[COLLECTIONS.groupRatios]: [],
	[COLLECTIONS.redemptionCodes]: [
		{ key: { codeDigest: 1 }, name: "uniq_code_digest", unique: true },
		{ key: { status: 1, batchId: 1 }, name: "status_batch" },
		{ key: { expiresAt: 1 }, name: "expiry", sparse: true },
	],
	[COLLECTIONS.quotaJournal]: [
		// The exactly-once anchor: (requestId, kind) can exist at most once.
		{ key: { requestId: 1, kind: 1 }, name: "uniq_request_kind", unique: true },
		{ key: { state: 1, createdAt: 1 }, name: "pending_scan" },
		{ key: { userId: 1, createdAt: -1 }, name: "by_user" },
	],
	[COLLECTIONS.tasks]: [
		{ key: { taskId: 1 }, name: "uniq_task", unique: true },
		{ key: { userId: 1, submitTime: -1 }, name: "owner_recent" },
		{ key: { status: 1, nextPollAt: 1 }, name: "poll_queue" },
		{ key: { platform: 1, upstreamTaskId: 1 }, name: "upstream_lookup", sparse: true },
	],
	[COLLECTIONS.usageRollups]: [
		{ key: { scope: 1, key: 1, bucket: 1 }, name: "uniq_rollup", unique: true },
		{ key: { bucket: -1 }, name: "recent" },
	],
	[COLLECTIONS.auditLogs]: [
		{ key: { actorId: 1, createdAt: -1 }, name: "actor_recent" },
		{ key: { targetType: 1, targetId: 1 }, name: "target" },
		// 400 days of retention, then automatic expiry.
		{ key: { createdAt: 1 }, name: "ttl_audit", expireAfterSeconds: 400 * 86_400 },
	],
	[COLLECTIONS.settings]: [],
	[COLLECTIONS.oauthStates]: [
		{ key: { expiresAt: 1 }, name: "ttl_state", expireAfterSeconds: 0 },
	],
}

/** Indexes applied to every monthly usage collection. */
export const USAGE_INDEXES: IndexSpec[] = [
	{ key: { requestId: 1 }, name: "uniq_request", unique: true },
	{ key: { userId: 1, createdAt: -1 }, name: "user_recent" },
	{ key: { channelId: 1, createdAt: -1 }, name: "channel_recent" },
	{ key: { model: 1, createdAt: -1 }, name: "model_recent" },
	{ key: { tokenId: 1, createdAt: -1 }, name: "token_recent" },
	{ key: { status: 1, createdAt: -1 }, name: "status_recent" },
	// Usage rows are summarised into rollups; the raw rows expire after 180 days.
	{ key: { createdAt: 1 }, name: "ttl_usage", expireAfterSeconds: 180 * 86_400 },
]

export async function ensureIndexes(db: Database, usageBuckets: string[] = []): Promise<string[]> {
	const applied: string[] = []
	for (const [name, specs] of Object.entries(INDEXES)) {
		if (specs.length === 0) continue
		await db.collection(name).createIndexes(specs)
		applied.push(`${name}: ${specs.map((s) => s.name).join(", ")}`)
	}
	for (const bucket of usageBuckets) {
		const name = usageCollectionName(bucket)
		await db.collection(name).createIndexes(USAGE_INDEXES)
		applied.push(`${name}: ${USAGE_INDEXES.map((s) => s.name).join(", ")}`)
	}
	return applied
}
