/**
 * Choosing a channel.
 *
 * Deliberately pure: no Redis, no Mongo, no clock. Tier walking and weighted
 * choice are the parts most likely to be subtly wrong - an off-by-one in the
 * tier clamp sends every retry back to the channel that just failed - and pure
 * functions can be tested exhaustively with a seeded random.
 *
 * The rules, in order:
 *   1. Group candidates into tiers of equal priority, highest first.
 *   2. Retry attempt N uses tier N, clamped to the last tier.
 *   3. Within a tier, choose at random weighted by `weight + 10`, so a
 *      zero-weight channel still receives a share rather than starving.
 */

import type { Candidate } from "./abilities.ts"

/** Added to every weight so that weight 0 means "rarely", not "never". */
export const WEIGHT_FLOOR = 10

export type ElectionOptions = {
	/** Zero-based retry attempt; selects the tier. */
	attempt?: number
	/** A channel to prefer on the first attempt, if it is still a candidate. */
	affinityChannelId?: string | null
	/** Injectable for deterministic tests. */
	random?: () => number
}

/** Groups candidates into descending priority tiers. */
export function tiersOf(candidates: Candidate[]): Candidate[][] {
	const byPriority = new Map<number, Candidate[]>()
	for (const candidate of candidates) {
		const tier = byPriority.get(candidate.priority)
		if (tier) tier.push(candidate)
		else byPriority.set(candidate.priority, [candidate])
	}
	return [...byPriority.entries()].sort((a, b) => b[0] - a[0]).map(([, tier]) => tier)
}

/**
 * Weighted random choice within a tier.
 *
 * Uses the half-open interval [0, total) so the last candidate is not favoured
 * by a boundary hit, and falls back to the final element only if floating
 * point leaves the cursor exactly at the total.
 */
export function weightedPick(tier: Candidate[], random: () => number = Math.random): Candidate | null {
	if (tier.length === 0) return null
	if (tier.length === 1) return tier[0]

	const total = tier.reduce((sum, c) => sum + Math.max(0, c.weight) + WEIGHT_FLOOR, 0)
	let cursor = random() * total
	for (const candidate of tier) {
		cursor -= Math.max(0, candidate.weight) + WEIGHT_FLOOR
		if (cursor < 0) return candidate
	}
	return tier[tier.length - 1]
}

/**
 * Elects one candidate.
 *
 * @returns the chosen candidate, or null when nothing is available - the
 *   caller turns that into a 503 rather than guessing.
 */
export function electFrom(candidates: Candidate[], options: ElectionOptions = {}): Candidate | null {
	if (candidates.length === 0) return null

	const attempt = Math.max(0, Math.floor(options.attempt ?? 0))
	const tiers = tiersOf(candidates)
	if (tiers.length === 0) return null

	// Later retries walk down the tiers; once past the last one, stay there.
	const tier = tiers[Math.min(attempt, tiers.length - 1)]

	// Affinity only applies to the first attempt. Re-pinning to the same
	// channel on a retry would defeat the point of retrying.
	if (attempt === 0 && options.affinityChannelId) {
		const pinned = tier.find((c) => c.channelId === options.affinityChannelId)
		if (pinned) return pinned
	}

	return weightedPick(tier, options.random)
}
