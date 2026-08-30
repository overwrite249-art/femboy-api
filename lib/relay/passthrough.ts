/**
 * Byte-faithful relay for endpoints that are not JSON in and JSON out.
 *
 * Transcription and image editing arrive as multipart with a file part;
 * speech synthesis returns audio bytes. Re-encoding either through a JSON
 * transform would corrupt them, and rebuilding a multipart body means
 * inventing a boundary and hoping every provider parses it the same way.
 * So the bytes are forwarded exactly as received.
 *
 * Everything that protects the gateway still applies. The only thing that
 * changes is that the payload is opaque, which has one real consequence:
 * usage often is not reported, so these requests are billed from the
 * model's per-call price plus an input-size estimate rather than from a
 * token count the provider never sent.
 */

import { config } from "../config/env.ts"
import { assertModelAllowed, authenticate, effectiveDirectives } from "../auth/authenticate.ts"
import type { AuthContext } from "../auth/authenticate.ts"
import {
	acquireConcurrency,
	chargeTokenBudget,
	enforceRequestLimits,
	enforceSuccessWindow,
} from "../ratelimit/index.ts"
import { finalizeQuota, preConsumedQuota, releaseQuota, reserveQuota } from "../quota/index.ts"
import { withChannelRetry } from "../routing/retry.ts"
import type { AttemptContext } from "../routing/retry.ts"
import { readCappedText, upstreamFetch } from "../upstream/fetch.ts"
import { recordUsage } from "../usage/index.ts"
import { EMPTY_USAGE, normalizeUsage } from "../usage/measure.ts"
import { billedModelFor, computeQuota } from "../usage/billing.ts"
import { resolvePricing, usageSemanticFor } from "../pricing/index.ts"
import { buildUpstreamHeaders, filterDownstreamHeaders } from "../http/headers.ts"
import { errorResponse } from "../http/respond.ts"
import { GatewayError, fromUpstream, invalidRequest } from "../http/errors.ts"
import { asRecord, asString, safeJsonParse } from "../util/json.ts"
import { JsonLimitError } from "../util/json.ts"
import { nowMs } from "../util/time.ts"
import { dialectFor, providerAuthHeaders, upstreamUrlFor } from "../transform/index.ts"
import type { Endpoint } from "../transform/index.ts"

export type PassthroughUpstream = (
	url: string,
	init: RequestInit,
	options: {
		signal?: AbortSignal | null
		headerTimeoutMs?: number
		idleTimeoutMs?: number
		maxBytes?: number
	},
) => Promise<Response>

export type PassthroughInput = {
	req: Request
	auth: AuthContext
	endpoint: Endpoint
	model: string
	bodyBytes: Uint8Array
	contentType: string
	maxAttempts?: number
	upstream?: PassthroughUpstream
	recordBuffered?: boolean
}

/**
 * Reads a body with the ceiling applied during the read, so an oversized
 * upload is refused while it is still arriving (GW-008).
 */
export async function readLimitedBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array(0)
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			total += value.byteLength
			if (total > maxBytes) {
				throw new JsonLimitError("bytes", `payload exceeds ${maxBytes} bytes`)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	const merged = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return merged
}

/**
 * Pulls the model out of a multipart body without rebuilding it. Parsing a
 * copy and forwarding the original avoids any chance of the two disagreeing.
 */
async function modelFromMultipart(
	bytes: Uint8Array,
	contentType: string,
	fallback?: string,
): Promise<string> {
	try {
		const form = await new Response(bytes as unknown as BodyInit, {
			headers: { "content-type": contentType },
		}).formData()
		const value = form.get("model")
		const model = typeof value === "string" ? value : ""
		if (model !== "") return model
	} catch {
		// Fall through to the default; a malformed form is the provider's
		// error to report, not ours to guess at.
	}
	if (fallback) return fallback
	throw invalidRequest("the model field is required", "model")
}

function modelFromJson(bytes: Uint8Array, fallback?: string): string {
	const text = new TextDecoder().decode(bytes)
	if (text.trim() !== "") {
		const parsed = asRecord(safeJsonParse<unknown>(text))
		const model = asString(parsed.model)
		if (model !== "") return model
	}
	if (fallback) return fallback
	throw invalidRequest("the model field is required", "model")
}

export async function relayPassthrough(input: PassthroughInput): Promise<Response> {
	const { auth, req, endpoint, model } = input
	const identity = auth.identity
	const requestId = auth.requestId
	const startedAt = auth.startedAt || nowMs()
	const call = input.upstream ?? upstreamFetch

	assertModelAllowed(identity, model)

	const directives = effectiveDirectives(auth)
	const group = identity.role === "user" ? identity.group : directives.group || identity.group

	await enforceRequestLimits(identity, auth.ipHash)
	await enforceSuccessWindow(identity, requestId)

	const lease = await acquireConcurrency(
		"user",
		identity.userId,
		identity.rpmLimit > 0 ? Math.max(2, Math.ceil(identity.rpmLimit / 10)) : 0,
	)
	let leaseReleased = false
	const releaseLease = async (): Promise<void> => {
		if (leaseReleased) return
		leaseReleased = true
		await lease.release().catch(() => {})
	}

	const billedModel = billedModelFor(model, model)
	const semantic = usageSemanticFor(billedModel)
	// Audio and image payloads carry no token count, so size stands in for one.
	const inputEstimate = Math.max(1, Math.ceil(input.bodyBytes.byteLength / 4))
	let reserved = false

	try {
		const { pricing, groupRatio } = await resolvePricing(billedModel, group)
		const estimated = computeQuota(
			{ ...EMPTY_USAGE, promptTokens: Math.min(inputEstimate, 8192) },
			pricing,
			groupRatio,
			billedModel,
		).quota
		await reserveQuota(identity, requestId, Math.max(preConsumedQuota(), estimated))
		reserved = true

		const outcome = await withChannelRetry(
			{
				group,
				model,
				signal: req.signal,
				maxAttempts: input.maxAttempts ?? config.retryTimes + 1,
			},
			async (context: AttemptContext) => {
				const wire = dialectFor(context.channel.type)
				const url = upstreamUrlFor(context.channel, {
					endpoint,
					model: context.model.mapped,
					stream: false,
				})
				const headers = buildUpstreamHeaders({
					clientHeaders: req.headers,
					authHeaders: providerAuthHeaders(context.channel.type, context.key.secret),
					channelHeaders: context.channel.headers,
					// Verbatim: a multipart type carries the boundary with it.
					contentType: input.contentType,
				})

				const response = await call(
					url,
					{ method: "POST", headers, body: input.bodyBytes as unknown as BodyInit },
					{
						signal: req.signal,
						headerTimeoutMs: Math.max(
							1_000,
							Math.min(config.upstreamHeaderTimeoutMs, context.remainingMs),
						),
						idleTimeoutMs: config.streamingIdleTimeoutMs,
						maxBytes: config.maxUpstreamResponseBytes,
					},
				)

				if (!response.ok) {
					const detail = await readCappedText(response).catch(() => "")
					throw fromUpstream(response.status, detail, context.channel._id)
				}
				return { response, wire, mappedModel: context.model.mapped }
			},
		)

		const { response, mappedModel } = outcome.value
		const downstream = filterDownstreamHeaders(response.headers)
		downstream.set("x-request-id", requestId)

		const contentType = response.headers.get("content-type") ?? ""
		const isJson = contentType.includes("json")

		// A JSON reply may carry real usage; audio bytes never will.
		let usage = { ...EMPTY_USAGE, promptTokens: Math.min(inputEstimate, 8192) }
		let payload: BodyInit

		if (isJson) {
			const text = await readCappedText(response)
			payload = text
			try {
				const parsed = asRecord(JSON.parse(text))
				const reported = normalizeUsage(parsed.usage, semantic)
				if (reported.promptTokens > 0 || reported.completionTokens > 0) usage = reported
			} catch {
				// Not every provider returns JSON it claims to; bill the estimate.
			}
		} else {
			payload = await response.arrayBuffer()
		}

		const quota = computeQuota(usage, pricing, groupRatio, billedModel).quota
		await finalizeQuota(identity, requestId, quota).catch(() => {})
		reserved = false
		await chargeTokenBudget(identity, usage.completionTokens).catch(() => {})
		await recordUsage(
			{
				requestId,
				userId: identity.userId,
				tokenId: identity.tokenId,
				channelId: outcome.channelId,
				group,
				model,
				mappedModel,
				billedModel,
				endpoint,
				dialect: "openai",
				stream: false,
				usage,
				quota,
				elapsedMs: nowMs() - startedAt,
				retries: Math.max(0, outcome.attempts - 1),
				status: "success",
				httpStatus: 200,
				ipHash: auth.ipHash,
			},
			{ buffered: input.recordBuffered ?? true },
		).catch(() => {})
		await releaseLease()

		return new Response(payload, { status: 200, headers: downstream })
	} catch (error) {
		if (reserved) await releaseQuota(identity, requestId).catch(() => {})
		const gatewayError = GatewayError.from(error)
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
				dialect: "openai",
				stream: false,
				quota: 0,
				elapsedMs: nowMs() - startedAt,
				status: "error",
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

export type PassthroughRouteOptions = {
	endpoint: Endpoint
	/** True when the client sends multipart/form-data with a file part. */
	multipart?: boolean
	defaultModel?: string
}

export async function handlePassthroughRequest(
	req: Request,
	options: PassthroughRouteOptions,
): Promise<Response> {
	let requestId = ""
	try {
		const auth = await authenticate(req)
		requestId = auth.requestId

		const contentType = req.headers.get("content-type") ?? "application/octet-stream"
		const bytes = await readLimitedBytes(req.body, config.maxRequestBodyBytes)
		const model = options.multipart
			? await modelFromMultipart(bytes, contentType, options.defaultModel)
			: modelFromJson(bytes, options.defaultModel)

		return await relayPassthrough({
			req,
			auth,
			endpoint: options.endpoint,
			model,
			bodyBytes: bytes,
			contentType,
		})
	} catch (error) {
		return errorResponse(error, "openai", { requestId })
	}
}
