/**
 * Retry across channels.
 *
 * Retrying is how a gateway hides a single bad upstream, and also how it turns
 * one client request into a stampede against every provider it knows (GW-014).
 * Three things keep that in check: a hard attempt count, a wall-clock budget
 * shared by all attempts, and a classification step that refuses to retry
 * anything the retry cannot possibly fix.
 *
 * The last point is the subtle one. The published retry matrix describes
 * *upstream* HTTP statuses. Gateway-side failures carry their own status in
 * the same field, and several of them - 402 for exhausted quota, 403 for a
 * model the key may not use - sit inside bands the matrix calls retryable.
 * Running them through it would replay a request the user cannot pay for
 * against every remaining channel. So the matrix is only consulted when the
 * error actually came from an upstream.
 */

import { config } from "../config/env.ts"
import type { ChannelDoc } from "../db/types.ts"
import { ErrorCode, GatewayError, isRetryableStatus } from "../http/errors.ts"
import { backoffDelayMs, Deadline, sleep } from "../util/time.ts"
import { recordChannelOutcome } from "./health.ts"
import { markKeyFailure, markKeyUsed, pickChannelKey } from "./keys.ts"
import type { SelectedKey } from "./keys.ts"
import { selectChannel } from "./index.ts"
import type { ResolvedModel } from "./mapping.ts"

export type AttemptContext = {
	/** Zero-based. */
	attempt: number
	channel: ChannelDoc
	model: ResolvedModel
	key: SelectedKey
	/** Time left for the whole request, across all attempts. */
	remainingMs: number
}

export type RelayOutcome<T> = {
	value: T
	/** Number of attempts made, including the successful one. */
	attempts: number
	channelId: string
	model: ResolvedModel
}

export type RetryRequest = {
	group: string
	model: string
	affinityHash?: string | null
	signal?: AbortSignal | null
	/** Overrides for tests. */
	maxAttempts?: number
	budgetMs?: number
	random?: () => number
}

/**
 * Whether another channel could plausibly do better.
 *
 * Errors with no upstream status originated here, so only an explicit
 * `retryable` flag makes them eligible.
 */
export function shouldRetryError(error: GatewayError): boolean {
	// A truncated or unparseable body is not transient; the same request will
	// produce the same garbage.
	if (error.code === ErrorCode.MALFORMED_UPSTREAM_BODY) return false
	// The client hung up. There is nobody left to answer.
	if (error.status === 499) return false
	if (typeof error.upstreamStatus === "number") return isRetryableStatus(error.upstreamStatus)
	return error.retryable === true
}

/**
 * Runs `attempt` against successive channels until one succeeds.
 *
 * A channel that fails is excluded from later attempts, and its failure is
 * recorded so the breaker can take it out of rotation for everyone else.
 */
export async function withChannelRetry<T>(
	request: RetryRequest,
	attempt: (context: AttemptContext) => Promise<T>,
): Promise<RelayOutcome<T>> {
	const maxAttempts = Math.max(1, request.maxAttempts ?? config.retryTimes + 1)
	const deadline = new Deadline(request.budgetMs ?? config.retryBudgetMs)
	const triedChannels: string[] = []
	const triedKeys: string[] = []
	let lastError: GatewayError | null = null

	for (let i = 0; i < maxAttempts; i++) {
		if (request.signal?.aborted) {
			throw GatewayError.from(new DOMException("Aborted", "AbortError"))
		}
		// Out of time. Surface why the last attempt failed rather than a bare
		// timeout, which would hide the actual upstream problem.
		if (deadline.expired && lastError) throw lastError

		// Selection failures are terminal: no channel is available now, and
		// trying again in a few milliseconds will not change that.
		const selection = await selectChannel({
			group: request.group,
			model: request.model,
			attempt: i,
			affinityHash: request.affinityHash,
			excludeChannelIds: triedChannels,
			random: request.random,
		})

		const channelId = selection.channel._id
		let key: SelectedKey
		try {
			key = await pickChannelKey(channelId, triedKeys)
		} catch (error) {
			// A channel with no usable credentials is a configuration problem,
			// not an upstream one, but other channels may still work.
			lastError = GatewayError.from(error)
			triedChannels.push(channelId)
			continue
		}

		try {
			const value = await attempt({
				attempt: i,
				channel: selection.channel,
				model: selection.model,
				key,
				remainingMs: deadline.remainingMs,
			})
			await recordChannelOutcome(channelId, true)
			await markKeyUsed(key.keyId)
			return { value, attempts: i + 1, channelId, model: selection.model }
		} catch (error) {
			const failure = GatewayError.from(error)
			lastError = failure

			// A client abort says nothing about the channel's health.
			if (failure.status !== 499) {
				await recordChannelOutcome(channelId, false)
				await markKeyFailure(key.keyId)
			}

			if (!shouldRetryError(failure)) throw failure

			triedChannels.push(channelId)
			triedKeys.push(key.fingerprint)

			const isLast = i === maxAttempts - 1
			if (isLast || deadline.expired) throw failure

			// Back off, but never past the budget - sleeping through the
			// remaining time would turn a retryable error into a timeout.
			const delay = Math.min(backoffDelayMs(i), deadline.remainingMs)
			if (delay > 0) {
				try {
					await sleep(delay, request.signal ?? undefined)
				} catch {
					throw GatewayError.from(new DOMException("Aborted", "AbortError"))
				}
			}
		}
	}

	throw lastError ?? GatewayError.from(new Error("retry loop exhausted without an error"))
}
