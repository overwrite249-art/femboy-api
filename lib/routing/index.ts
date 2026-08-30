/**
 * Channel selection, end to end.
 *
 * Ties together the ability lookup, the breaker, election and model mapping.
 * The important detail is that nothing the cache says is trusted: the elected
 * channel is loaded fresh and re-checked against the request's group before it
 * is handed back. An ability row is a derived artefact and can outlive the
 * grant that produced it, so treating it as an authorisation decision would
 * let a removed group keep working until a cron catches up.
 */

import { config } from "../config/env.ts"
import { channels } from "../db/index.ts"
import type { ChannelDoc } from "../db/types.ts"
import { noChannelAvailable } from "../http/errors.ts"
import { redisGet, redisSet } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import { candidatesFor, serves } from "./abilities.ts"
import type { Candidate } from "./abilities.ts"
import { electFrom } from "./election.ts"
import { openChannels } from "./health.ts"
import { resolveModel } from "./mapping.ts"
import type { ResolvedModel } from "./mapping.ts"

export type SelectionRequest = {
	group: string
	model: string
	/** Zero-based retry attempt. */
	attempt?: number
	/** Stable hash used to pin a conversation to one channel. */
	affinityHash?: string | null
	/** Channels already tried in this request. */
	excludeChannelIds?: string[]
	random?: () => number
}

export type Selection = {
	channel: ChannelDoc
	model: ResolvedModel
	/** Candidates considered, for diagnostics. */
	considered: number
}

export async function selectChannel(request: SelectionRequest): Promise<Selection> {
	const { group, model } = request
	const attempt = request.attempt ?? 0
	const excluded = new Set(request.excludeChannelIds ?? [])

	const all = await candidatesFor(group, model)
	if (all.length === 0) {
		throw noChannelAvailable(`no channel serves ${model} for group ${group}`)
	}

	const notExcluded = all.filter((c) => !excluded.has(c.channelId))
	if (notExcluded.length === 0) {
		throw noChannelAvailable(`every channel for ${model} has already been tried`)
	}

	// Open breakers are removed rather than deprioritised. Routing to a channel
	// known to be failing wastes the caller's retry budget.
	const open = await openChannels(notExcluded.map((c) => c.channelId))
	const healthy = notExcluded.filter((c) => !open.has(c.channelId))
	if (healthy.length === 0) {
		throw noChannelAvailable(`all channels for ${model} are currently unhealthy`)
	}

	const affinityChannelId = request.affinityHash
		? await readAffinity(group, model, request.affinityHash)
		: null

	const channel = await electAndVerify(healthy, {
		attempt,
		affinityChannelId,
		random: request.random,
		group,
		model,
	})

	if (request.affinityHash) {
		await writeAffinity(group, model, request.affinityHash, channel._id)
	}

	return {
		channel,
		model: await resolveModel(model, channel),
		considered: healthy.length,
	}
}

/**
 * Elects a candidate and confirms it is genuinely eligible.
 *
 * A candidate that fails verification is dropped and the election is retried
 * with the rest, so one stale row does not fail the request.
 */
async function electAndVerify(
	candidates: Candidate[],
	options: {
		attempt: number
		affinityChannelId: string | null
		random?: () => number
		group: string
		model: string
	},
): Promise<ChannelDoc> {
	let pool = candidates
	const collection = await channels()

	// Bounded so a table full of stale rows cannot spin.
	for (let i = 0; i < 8 && pool.length > 0; i++) {
		const elected = electFrom(pool, {
			attempt: options.attempt,
			affinityChannelId: options.affinityChannelId,
			random: options.random,
		})
		if (!elected) break

		const channel = await collection.findOne({ _id: elected.channelId })
		// The cache said yes; the channel itself is the authority.
		if (channel && serves(channel, options.group, options.model)) return channel

		pool = pool.filter((c) => c.channelId !== elected.channelId)
	}

	throw noChannelAvailable(`no eligible channel serves ${options.model} for group ${options.group}`)
}

function affinityRule(group: string, model: string): string {
	return `${group}/${model}`
}

async function readAffinity(group: string, model: string, hash: string): Promise<string | null> {
	try {
		const value = await redisGet(K.affinity(affinityRule(group, model), hash))
		return typeof value === "string" && value ? value : null
	} catch {
		return null
	}
}

async function writeAffinity(
	group: string,
	model: string,
	hash: string,
	channelId: string,
): Promise<void> {
	await redisSet(K.affinity(affinityRule(group, model), hash), channelId, config.affinityTtlSec).catch(
		() => undefined,
	)
}

export { candidatesFor, rebuildAbilities, invalidateAbilities, serves } from "./abilities.ts"
export type { Candidate } from "./abilities.ts"
export { electFrom, tiersOf, weightedPick, WEIGHT_FLOOR } from "./election.ts"
export {
	channelFailCount,
	isChannelOpen,
	openChannels,
	recordChannelOutcome,
	resetChannelHealth,
} from "./health.ts"
export { billedModel, resolveModel } from "./mapping.ts"
export type { ResolvedModel } from "./mapping.ts"
export { listChannelKeys, markKeyFailure, markKeyUsed, pickChannelKey } from "./keys.ts"
export type { SelectedKey } from "./keys.ts"
