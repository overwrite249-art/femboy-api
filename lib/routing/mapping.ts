/**
 * Model name rewriting.
 *
 * A deployment often exposes a stable public name and points it at whatever
 * upstream model is current, or routes one name to different models per
 * channel. Two layers apply, global first and then channel-specific, so a
 * channel can override the global default without replacing it.
 *
 * Rewriting only ever affects the name sent upstream. What the user is charged
 * for is the name they asked for (GW-013) - otherwise changing a mapping would
 * silently change everybody's bill.
 */

import { config } from "../config/env.ts"
import { modelMappings } from "../db/index.ts"
import type { ChannelDoc } from "../db/types.ts"
import { redisGetJson, redisSetJson } from "../redis/client.ts"
import { K } from "../redis/keys.ts"

export type ResolvedModel = {
	/** What the client asked for, and what they are billed for. */
	requested: string
	/** What is actually sent upstream. */
	mapped: string
}

const GLOBAL_CACHE_KEY = `${K.channel("__model_map__")}:global`

async function globalMappings(): Promise<Record<string, string>> {
	const cached = await redisGetJson<Record<string, string>>(GLOBAL_CACHE_KEY).catch(() => null)
	if (cached && typeof cached === "object") return cached

	const table: Record<string, string> = {}
	try {
		const collection = await modelMappings()
		const rows = await collection.find({}, { limit: 2000 })
		for (const row of rows) {
			// Channel-scoped rows are applied later, not here.
			if (row.channelId) continue
			if (row.from && row.to) table[row.from] = row.to
		}
	} catch {
		return {}
	}

	await redisSetJson(GLOBAL_CACHE_KEY, table, config.channelCacheTtlSec).catch(() => undefined)
	return table
}

async function channelScopedMappings(channelId: string): Promise<Record<string, string>> {
	try {
		const collection = await modelMappings()
		const rows = await collection.find({ channelId }, { limit: 500 })
		const table: Record<string, string> = {}
		for (const row of rows) if (row.from && row.to) table[row.from] = row.to
		return table
	} catch {
		return {}
	}
}

/**
 * Resolves the upstream model name for a request.
 *
 * Each layer is applied at most once. Mappings are not followed transitively,
 * so a misconfigured pair like a -> b and b -> a cannot loop.
 */
export async function resolveModel(requested: string, channel: ChannelDoc): Promise<ResolvedModel> {
	let mapped = requested

	const global = await globalMappings()
	if (global[mapped]) mapped = global[mapped]

	const scoped = await channelScopedMappings(channel._id)
	if (scoped[mapped]) mapped = scoped[mapped]
	else if (scoped[requested]) mapped = scoped[requested]

	const inline = channel.modelMapping ?? {}
	if (inline[mapped]) mapped = inline[mapped]
	else if (inline[requested]) mapped = inline[requested]

	return { requested, mapped }
}

/**
 * The model whose price applies. Stated as a function so the rule lives in one
 * place: the requested name, always.
 */
export function billedModel(resolved: ResolvedModel): string {
	return resolved.requested
}
