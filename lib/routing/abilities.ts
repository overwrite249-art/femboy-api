/**
 * Which channels can serve a given group and model.
 *
 * The `abilities` collection is a denormalised join of channels, their groups
 * and their models. Computing it per request would mean scanning every channel
 * on every call; keeping it as rows lets one indexed lookup answer the
 * question.
 *
 * Being a cache, it can be stale. Nothing here is treated as authoritative -
 * the elected channel is re-read and re-checked before it is used.
 */

import { config } from "../config/env.ts"
import { abilities, channels } from "../db/index.ts"
import type { AbilityDoc, ChannelDoc } from "../db/types.ts"
import { redisCommand, redisGetJson, redisSetJson } from "../redis/client.ts"
import { K } from "../redis/keys.ts"

export type Candidate = {
	channelId: string
	priority: number
	weight: number
}

function toCandidate(doc: Pick<AbilityDoc, "channelId" | "priority" | "weight">): Candidate {
	return {
		channelId: doc.channelId,
		priority: Number(doc.priority) || 0,
		weight: Number(doc.weight) || 0,
	}
}

/**
 * A monotonically increasing counter folded into every cache key. Bumping it
 * invalidates every group/model entry at once, which is what an operator
 * expects after editing a channel - far cheaper than deleting each key.
 */
async function abilityGeneration(): Promise<number> {
	const raw = await redisCommand(["GET", K.abilityGeneration()]).catch(() => null)
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? n : 1
}

export async function invalidateAbilities(): Promise<void> {
	await redisCommand(["INCR", K.abilityGeneration()]).catch(() => undefined)
}

/** Candidates for a group and model, ordered by priority then weight. */
export async function candidatesFor(group: string, model: string): Promise<Candidate[]> {
	const generation = await abilityGeneration()
	const cacheKey = `${K.ability(group, model)}:g${generation}`

	const cached = await redisGetJson<Candidate[]>(cacheKey).catch(() => null)
	if (Array.isArray(cached)) return cached

	let found: Candidate[] = []
	try {
		const collection = await abilities()
		const rows = await collection.find(
			{ group, model, enabled: true },
			{ sort: { priority: -1, weight: -1 }, limit: 200 },
		)
		found = rows.map(toCandidate)
	} catch {
		found = []
	}

	// Before the first rebuild the table is empty. Deriving candidates from the
	// channels themselves keeps a fresh deployment working instead of returning
	// "no channel available" until a cron happens to run.
	if (found.length === 0) found = await deriveCandidates(group, model)

	await redisSetJson(cacheKey, found, config.abilityCacheTtlSec).catch(() => undefined)
	return found
}

/** The uncached fallback path: scan enabled channels directly. */
async function deriveCandidates(group: string, model: string): Promise<Candidate[]> {
	try {
		const collection = await channels()
		const rows = await collection.find({ status: "enabled" }, { limit: 500 })
		return rows
			.filter((channel) => serves(channel, group, model))
			.map((channel) => ({
				channelId: channel._id,
				priority: Number(channel.priority) || 0,
				weight: Number(channel.weight) || 0,
			}))
			.sort((a, b) => b.priority - a.priority || b.weight - a.weight)
	} catch {
		return []
	}
}

/**
 * Whether a channel is configured to serve this group and model.
 *
 * An empty model list means "any model", which is how catch-all channels are
 * configured. An empty group list means the channel is not offered to anyone -
 * absence of a grant is not a grant.
 */
export function serves(channel: ChannelDoc, group: string, model: string): boolean {
	if (channel.status !== "enabled") return false
	const groups = channel.groups ?? []
	if (!groups.includes(group) && !groups.includes("*")) return false
	const models = channel.models ?? []
	if (models.length === 0) return true
	return models.includes(model) || models.includes("*")
}

/**
 * Recomputes the whole ability table.
 *
 * The SQL original did this in a stored procedure; here it is an ordinary
 * rewrite. Rows are replaced wholesale rather than diffed because the table is
 * small and a partial update risks leaving a grant behind after a channel
 * loses a group.
 */
export async function rebuildAbilities(): Promise<number> {
	const channelCollection = await channels()
	const abilityCollection = await abilities()
	const rows = await channelCollection.find({ status: "enabled" }, { limit: 10_000 })

	const docs: AbilityDoc[] = []
	const now = new Date()
	for (const channel of rows) {
		const groups = channel.groups ?? []
		const models = channel.models ?? []
		if (groups.length === 0 || models.length === 0) continue
		for (const group of groups) {
			for (const model of models) {
				docs.push({
					_id: `${group}:${model}:${channel._id}`,
					group,
					model,
					channelId: channel._id,
					enabled: true,
					priority: Number(channel.priority) || 0,
					weight: Number(channel.weight) || 0,
					updatedAt: now,
				})
			}
		}
	}

	await abilityCollection.deleteMany({})
	if (docs.length > 0) await abilityCollection.insertMany(docs, false)
	await invalidateAbilities()
	return docs.length
}
