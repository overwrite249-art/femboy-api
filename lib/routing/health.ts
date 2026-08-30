/**
 * Per-channel circuit breaker.
 *
 * A failing upstream is not just slow, it is expensive: every attempt costs a
 * reservation, a retry and a slice of the request budget. The breaker takes a
 * channel out of rotation once it has failed enough times in a row, and lets
 * it back in after a cooldown rather than probing it on every request.
 *
 * State lives in Redis because it has to be shared across serverless
 * invocations - a per-process breaker in a function runtime never trips.
 */

import { config } from "../config/env.ts"
import { channels } from "../db/index.ts"
import { redisCommand, runScript } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import { nowMs } from "../util/time.ts"

export type ChannelOutcome = {
	/** True when this outcome tripped the breaker. */
	tripped: boolean
	fails: number
	autoDisabled: boolean
}

function toNumber(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : fallback
}

/** Whether the breaker is currently open for this channel. */
export async function isChannelOpen(channelId: string): Promise<boolean> {
	try {
		const raw = await redisCommand(["HGET", K.channelHealth(channelId), "openUntil"])
		return toNumber(raw) > nowMs()
	} catch {
		// If health state is unreadable, treat the channel as usable. Failing
		// closed here would take every channel out at once on a Redis blip.
		return false
	}
}

/** The subset of ids whose breaker is open, resolved in one pass. */
export async function openChannels(channelIds: string[]): Promise<Set<string>> {
	const open = new Set<string>()
	const results = await Promise.all(
		channelIds.map(async (id) => ({ id, open: await isChannelOpen(id) })),
	)
	for (const entry of results) if (entry.open) open.add(entry.id)
	return open
}

/**
 * Records the result of using a channel.
 *
 * Consecutive failures trip the breaker; a single success clears the counter,
 * so intermittent errors never accumulate into a false trip.
 */
export async function recordChannelOutcome(channelId: string, ok: boolean): Promise<ChannelOutcome> {
	let tripped = false
	let fails = 0
	try {
		const result = (await runScript(
			"health",
			[K.channelHealth(channelId)],
			[ok ? 1 : 0, config.channelFailureThreshold, config.channelCooldownSec, nowMs()],
		)) as unknown[]
		tripped = toNumber(result?.[0]) === 1
		fails = toNumber(result?.[1])
	} catch {
		return { tripped: false, fails: 0, autoDisabled: false }
	}

	const limit = config.channelAutoDisableFails
	if (!ok && limit > 0 && fails >= limit) {
		const disabled = await autoDisableChannel(channelId, fails)
		return { tripped, fails, autoDisabled: disabled }
	}
	return { tripped, fails, autoDisabled: false }
}

/**
 * Takes a persistently broken channel out of service for good.
 *
 * Guarded on the current status so a channel an operator has already disabled
 * is not rewritten, and so two concurrent failures do not both claim the
 * transition.
 */
async function autoDisableChannel(channelId: string, fails: number): Promise<boolean> {
	try {
		const collection = await channels()
		const updated = await collection.findOneAndUpdate(
			{ _id: channelId, status: "enabled" },
			{
				$set: {
					status: "disabled",
					autoDisabled: true,
					failCount: fails,
					updatedAt: new Date(),
				},
			},
		)
		return updated !== null
	} catch {
		return false
	}
}

/** Clears breaker state, used by the health cron and by operators. */
export async function resetChannelHealth(channelId: string): Promise<void> {
	await redisCommand(["DEL", K.channelHealth(channelId)]).catch(() => undefined)
}

/** Current failure count, for the admin console. */
export async function channelFailCount(channelId: string): Promise<number> {
	const raw = await redisCommand(["HGET", K.channelHealth(channelId), "fails"]).catch(() => null)
	return toNumber(raw)
}
