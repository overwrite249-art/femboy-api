/**
 * The relay pipeline.
 *
 * Every inference request takes this path, and the order of the steps is the
 * security property rather than an implementation detail:
 *
 *  1. the caller is resolved and the model checked against the key's allowlist
 *  2. rate and concurrency limits are applied before any cost is incurred
 *  3. quota is reserved up front, so a request cannot outrun its balance
 *  4. a channel is elected, with retries across channels and keys
 *  5. the body is translated into the provider's dialect
 *  6. the reservation is settled against measured usage and a ledger row written
 *
 * Reserve-then-settle is what closes GW-001: concurrent requests cannot each
 * observe the same balance and collectively overspend it. Its cost is that
 * every exit path has to release, including the ones nobody plans for - an
 * upstream that returns garbage, or a client that disconnects halfway through
 * a stream (GW-009). Those paths are handled explicitly below; a `finally`
 * alone is not enough, because a stream outlives the function that created it.
 */

import { config } from "../config/env.ts"
import { assertModelAllowed, effectiveDirectives } from "../auth/authenticate.ts"
import type { AuthContext, Identity } from "../auth/authenticate.ts"
import type { KeyDirectives } from "../auth/keys.ts"
import {
	acquireConcurrency,
	chargeTokenBudget,
	enforceRequestLimits,
	enforceSuccessWindow,
	enforceTokenBudget,
} from "../ratelimit/index.ts"
import { finalizeQuota, preConsumedQuota, releaseQuota, reserveQuota } from "../quota/index.ts"
import { withChannelRetry } from "../routing/retry.ts"
import type { AttemptContext } from "../routing/retry.ts"
import { readCappedText, upstreamFetch } from "../upstream/fetch.ts"
import { recordUsage } from "../usage/index.ts"
import { EMPTY_USAGE, normalizeUsage } from "../usage/measure.ts"
import type { NormalizedUsage } from "../usage/measure.ts"
import { billedModelFor, computeQuota } from "../usage/billing.ts"
import { resolvePricing, usageSemanticFor } from "../pricing/index.ts"
import { buildUpstreamHeaders } from "../http/headers.ts"
import { errorSseChunk, jsonResponse, streamResponse } from "../http/respond.ts"
import { GatewayError, fromUpstream, malformedUpstreamBody } from "../http/errors.ts"
import { asNumber, asRecord, sanitizeParsed } from "../util/json.ts"
import { nowMs } from "../util/time.ts"
import {
	createStreamTranslator,
	dialectFor,
	providerAuthHeaders,
	sseEventStream,
	transformRequest,
	transformResponse,
	upstreamUrlFor,
} from "../transform/index.ts"
import type { Dialect, Endpoint } from "../transform/index.ts"
import { createClientFramer } from "../transform/framing.ts"

/**
 * The upstream call, injectable so the pipeline can be exercised without a
 * network and so the local harness can record traffic. Production always uses
 * `upstreamFetch`, which is where SSRF and stream guards live.
 */
export type UpstreamCall = (
	url: string,
	init: RequestInit,
	options: { signal?: AbortSignal | null; headerTimeoutMs?: number; idleTimeoutMs?: number },
) => Promise<Response>

export type RelayInput = {
	req: Request
	auth: AuthContext
	endpoint: Endpoint
	/** The dialect the client spoke, decided by the route. */
	clientDialect: Dialect
	body: Record<string, unknown>
	model: string
	stream: boolean
	/** True when the gateway added include_usage the client did not ask for. */
	usageInjected?: boolean
	affinityHash?: string | null
	/** Overrides for tests and the harness. */
	maxAttempts?: number
	budgetMs?: number
	random?: () => number
	upstream?: UpstreamCall
	recordBuffered?: boolean
}

/**
 * A group override may only be honoured for staff. Groups carry a billing
 * multiplier, so letting an ordinary key name its own group would let it name
 * its own price.
 */
function groupFor(identity: Identity, directives: KeyDirectives): string {
	if (identity.role === "user") return identity.group
	return directives.group || identity.group
}

/**
 * In-flight ceiling derived from the key's rate limit. A key allowed 60
 * requests a minute has no legitimate need for 60 simultaneous connections,
 * and slow upstreams are how a single caller exhausts the pool.
 */
function concurrencyCeiling(identity: Identity): number {
	if (identity.rpmLimit <= 0) return 0
	return Math.max(2, Math.ceil(identity.rpmLimit / 10))
}

/**
 * A cheap upper estimate, used only to size the reservation. It does not have
 * to be accurate - settlement corrects it - but it must not be zero, or a
 * request with no balance would reach the upstream before anyone noticed.
 */
function estimatePromptTokens(body: Record<string, unknown>): number {
	let size = 0
	try {
		size = JSON.stringify(body)?.length ?? 0
	} catch {
		size = 0
	}
	return Math.max(1, Math.ceil(size / 4))
}

function estimateCompletionTokens(body: Record<string, unknown>): number {
	const asked = asNumber(body.max_tokens) || asNumber(body.max_completion_tokens)
	// A caller may ask for a very large ceiling it will never reach. Reserving
	// against the request would deny service to a solvent account.
	return Math.min(Math.max(0, asked), 4096)
}

function rawUsageOf(dialect: Dialect, parsed: Record<string, unknown>): unknown {
	return dialect === "gemini" ? parsed.usageMetadata : parsed.usage
}

export async function relay(input: RelayInput): Promise<Response> {
	const { auth, body, model, stream, endpoint, clientDialect } = input
	const identity = auth.identity
	const requestId = auth.requestId
	const startedAt = auth.startedAt || nowMs()
	const call = input.upstream ?? upstreamFetch

	assertModelAllowed(identity, model)

	const directives = effectiveDirectives(auth)
	const group = groupFor(identity, directives)

	await enforceRequestLimits(identity, auth.ipHash)
	await enforceSuccessWindow(identity, requestId)

	const lease = await acquireConcurrency("user", identity.userId, concurrencyCeiling(identity))
	let leaseReleased = false
	const releaseLease = async (): Promise<void> => {
		if (leaseReleased) return
		leaseReleased = true
		await lease.release().catch(() => {})
	}

	// GW-013: price and report the model the client asked for, never the one
	// the channel happened to map it to.
	const billedModel = billedModelFor(model, model)
	const semantic = usageSemanticFor(billedModel)

	let reserved = false

	try {
		const { pricing, groupRatio } = await resolvePricing(billedModel, group)

		const promptEstimate = estimatePromptTokens(body)
		await enforceTokenBudget(identity, promptEstimate)

		const estimatedQuota = computeQuota(
			{
				...EMPTY_USAGE,
				promptTokens: promptEstimate,
				completionTokens: estimateCompletionTokens(body),
			},
			pricing,
			groupRatio,
			billedModel,
		).quota

		await reserveQuota(identity, requestId, Math.max(preConsumedQuota(), estimatedQuota))
		reserved = true

		/** Settles the reservation and writes the ledger row exactly once. */
		let settled = false
		const settle = async (args: {
			usage: NormalizedUsage
			channelId: string
			mappedModel: string
			attempts: number
			httpStatus: number
			status: "success" | "error" | "aborted"
			errorCode?: string
			firstByteMs?: number
		}): Promise<void> => {
			if (settled) return
			settled = true
			const quota = computeQuota(args.usage, pricing, groupRatio, billedModel).quota

			await finalizeQuota(identity, requestId, quota).catch(() => {})
			// Output tokens were not known when the budget was checked.
			await chargeTokenBudget(identity, args.usage.completionTokens).catch(() => {})
			await recordUsage(
				{
					requestId,
					userId: identity.userId,
					tokenId: identity.tokenId,
					channelId: args.channelId,
					group,
					model,
					mappedModel: args.mappedModel,
					billedModel,
					endpoint,
					dialect: clientDialect,
					stream,
					usage: args.usage,
					quota,
					elapsedMs: nowMs() - startedAt,
					firstByteMs: args.firstByteMs,
					retries: Math.max(0, args.attempts - 1),
					status: args.status,
					errorCode: args.errorCode,
					httpStatus: args.httpStatus,
					ipHash: auth.ipHash,
				},
				{ buffered: input.recordBuffered ?? true },
			).catch(() => {})
			await releaseLease()
		}

		const ceiling = config.retryTimes + 1
		const requestedAttempts =
			typeof directives.retry === "number" ? directives.retry + 1 : ceiling

		const outcome = await withChannelRetry(
			{
				group,
				model,
				affinityHash: input.affinityHash ?? null,
				signal: input.req.signal,
				// A directive may lower the retry ceiling but never raise it.
				maxAttempts: input.maxAttempts ?? Math.max(1, Math.min(ceiling, requestedAttempts)),
				budgetMs: input.budgetMs,
				random: input.random,
			},
			async (context: AttemptContext) => {
				const wire = dialectFor(context.channel.type)
				const upstreamBody = transformRequest({
					from: clientDialect,
					to: wire,
					body,
					model: context.model.mapped,
				})

				const url = upstreamUrlFor(context.channel, {
					endpoint,
					model: context.model.mapped,
					stream,
				})

				// The credential comes from the elected channel. The client's own
				// Authorization header is never forwarded.
				const headers = buildUpstreamHeaders({
					clientHeaders: input.req.headers,
					authHeaders: providerAuthHeaders(context.channel.type, context.key.secret),
					channelHeaders: context.channel.headers,
					contentType: "application/json",
				})
				if (stream) headers.set("accept", "text/event-stream")

				const response = await call(
					url,
					{ method: "POST", headers, body: JSON.stringify(upstreamBody) },
					{
						signal: input.req.signal,
						headerTimeoutMs: Math.max(1_000, Math.min(config.upstreamHeaderTimeoutMs, context.remainingMs)),
						idleTimeoutMs: config.streamingIdleTimeoutMs,
					},
				)

				if (!response.ok) {
					// Read the body before discarding it: the provider's message is
					// the only thing that makes an upstream failure diagnosable.
					const detail = await readCappedText(response).catch(() => "")
					throw fromUpstream(response.status, detail, context.channel._id)
				}

				return { response, wire, mappedModel: context.model.mapped }
			},
		)

		const { response, wire, mappedModel } = outcome.value
		const firstByteMs = nowMs() - startedAt

		if (!stream) {
			const text = await readCappedText(response)
			let parsed: Record<string, unknown>
			try {
				// GW-017: strip inherited keys before anything reads the object.
				parsed = sanitizeParsed(asRecord(JSON.parse(text)))
			} catch {
				await releaseQuota(identity, requestId).catch(() => {})
				reserved = false
				await releaseLease()
				throw malformedUpstreamBody()
			}

			const usage = normalizeUsage(rawUsageOf(wire, parsed), semantic)
			const clientBody = transformResponse({
				from: wire,
				to: clientDialect,
				body: parsed,
				requestedModel: model,
			})

			await settle({
				usage,
				channelId: outcome.channelId,
				mappedModel,
				attempts: outcome.attempts,
				httpStatus: 200,
				status: "success",
				firstByteMs,
			})
			reserved = false

			return jsonResponse(clientBody, { requestId })
		}

		// --- streaming -----------------------------------------------------
		if (!response.body) {
			await releaseQuota(identity, requestId).catch(() => {})
			reserved = false
			await releaseLease()
			throw malformedUpstreamBody("upstream returned no body for a streamed request")
		}

		const translator = createStreamTranslator({
			from: wire,
			model,
			id: requestId,
			suppressUsageFrame: input.usageInjected === true,
		})
		const framer = createClientFramer(clientDialect, { model, id: requestId })
		const reader = sseEventStream(response.body).getReader()
		const encoder = new TextEncoder()

		// From here the reservation is owned by the stream. Nothing after this
		// point may release it, because the function is about to return.
		reserved = false

		const finishStream = async (
			controller: ReadableStreamDefaultController<Uint8Array>,
			status: "success" | "error" | "aborted",
			errorCode?: string,
		): Promise<void> => {
			const usage = normalizeUsage(translator.usage(), semantic)
			const tail = framer.finish(translator.usage())
			if (tail !== "") controller.enqueue(encoder.encode(tail))
			await settle({
				usage,
				channelId: outcome.channelId,
				mappedModel,
				attempts: outcome.attempts,
				httpStatus: 200,
				status,
				errorCode,
				firstByteMs,
			})
			controller.close()
		}

		const out = new ReadableStream<Uint8Array>({
			start(controller) {
				const head = framer.start()
				if (head !== "") controller.enqueue(encoder.encode(head))
			},

			async pull(controller) {
				// A pull that resolves without enqueuing is never called again,
				// so keep reading until there is something to hand back.
				for (;;) {
					let result: ReadableStreamReadResult<Awaited<ReturnType<typeof reader.read>>["value"]>
					try {
						result = await reader.read()
					} catch (error) {
						const gatewayError = GatewayError.from(error)
						controller.enqueue(encoder.encode(errorSseChunk(gatewayError, clientDialect)))
						await finishStream(controller, "error", gatewayError.code)
						return
					}

					if (result.done) {
						await finishStream(controller, "success")
						return
					}

					let payload = ""
					try {
						for (const chunk of translator.handle(result.value)) {
							payload += framer.chunk(chunk)
						}
					} catch (error) {
						const gatewayError = GatewayError.from(error)
						controller.enqueue(encoder.encode(errorSseChunk(gatewayError, clientDialect)))
						await finishStream(controller, "error", gatewayError.code)
						return
					}

					if (payload !== "") {
						controller.enqueue(encoder.encode(payload))
						return
					}
					if (translator.done()) {
						await finishStream(controller, "success")
						return
					}
				}
			},

			// The client hung up. Settle for what was actually consumed rather
			// than letting the reservation expire silently (GW-009).
			async cancel() {
				await reader.cancel().catch(() => {})
				await settle({
					usage: normalizeUsage(translator.usage(), semantic),
					channelId: outcome.channelId,
					mappedModel,
					attempts: outcome.attempts,
					httpStatus: 200,
					status: "aborted",
				})
			},
		})

		return streamResponse(out, { requestId })
	} catch (error) {
		if (reserved) await releaseQuota(identity, requestId).catch(() => {})
		const gatewayError = GatewayError.from(error)
		// A failed request still gets a row: an error nobody can see is an error
		// nobody fixes.
		await recordUsage(
			{
				requestId,
				userId: identity.userId,
				tokenId: identity.tokenId,
				channelId: gatewayError.channelId ?? "",
				group,
				model,
				mappedModel: model,
				billedModel,
				endpoint,
				dialect: clientDialect,
				stream,
				quota: 0,
				elapsedMs: nowMs() - startedAt,
				status: gatewayError.status === 499 ? "aborted" : "error",
				errorCode: gatewayError.code,
				httpStatus: gatewayError.status,
				ipHash: auth.ipHash,
			},
			{ buffered: input.recordBuffered ?? true },
		).catch(() => {})
		await releaseLease()
		throw gatewayError
	}
}
