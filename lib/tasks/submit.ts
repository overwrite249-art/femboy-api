/**
 * Submitting an asynchronous job.
 *
 * Structurally this is the passthrough relay: authenticate, limit, reserve,
 * pick a channel, forward the bytes verbatim, settle, record. Two differences:
 *
 *   1. The response is parsed, because the provider's job id has to be captured
 *      and replaced with ours before the client sees it (GW-019).
 *   2. Channel election is by provider type rather than by model ability. A
 *      Midjourney job cannot be served by an OpenAI channel that happens to
 *      advertise every model, so the type is the selector.
 *
 * Channel health is deliberately not recorded here. A Midjourney queue that is
 * slow to accept work is not a broken channel, and feeding that into the same
 * breaker the chat path uses would trip channels that are working correctly.
 */

import { config } from "../config/env.ts"
import {
	assertModelAllowed,
	authenticate,
	effectiveDirectives,
} from "../auth/authenticate.ts"
import { channels } from "../db/index.ts"
import type { ChannelDoc, TaskPlatform } from "../db/types.ts"
import { buildUpstreamHeaders, filterDownstreamHeaders } from "../http/headers.ts"
import { GatewayError, forbidden, fromUpstream, malformedUpstreamBody, noChannelAvailable } from "../http/errors.ts"
import { redactProviderValue, sanitizeProviderError } from "../http/redact.ts"
import { asRecord, safeJsonParse } from "../util/json.ts"
import { isTaskSubmitPathAllowed, prepareTaskBody } from "./policy.ts"
import { errorResponse, jsonResponse } from "../http/respond.ts"
import { finalizeQuota, preConsumedQuota, releaseQuota, reserveQuota } from "../quota/index.ts"
import { enforceRequestLimits, enforceSuccessWindow } from "../ratelimit/index.ts"
import { readLimitedBytes } from "../relay/passthrough.ts"
import { pickChannelKey, selectChannelKey } from "../routing/keys.ts"
import { providerAuthHeaders } from "../transform/index.ts"
import type { Endpoint } from "../transform/index.ts"
import { readCappedText, upstreamFetch } from "../upstream/fetch.ts"
import { recordUsage } from "../usage/index.ts"
import { billedModelFor, computeQuota } from "../usage/billing.ts"
import { EMPTY_USAGE } from "../usage/measure.ts"
import { resolvePricing } from "../pricing/index.ts"
import { nowMs } from "../util/time.ts"
import {
	createTask,
	extractUpstreamTaskId,
	listTasks,
	markSubmitted,
	mjTaskView,
	publicTask,
	requireTask,
	rewriteTaskId,
	updateTask,
} from "./index.ts"

export type TaskSubmitOptions = {
	platform: TaskPlatform
	/** The provider-side path, for example "/mj/submit/imagine". */
	path: string
	action: string
	/**
	 * Usage rows need a real Endpoint value. Async media is recorded as a
	 * generation, which is what it is.
	 */
	endpoint?: Endpoint
	maxChannels?: number
}

function parseJsonObject(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = safeJsonParse(text, { maxBytes: config.maxUpstreamResponseBytes })
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
	} catch {
		// Providers are not always honest about returning JSON.
	}
	throw malformedUpstreamBody()
}

async function candidateChannels(platform: string, group: string): Promise<ChannelDoc[]> {
	const collection = await channels()
	const rows = await collection.find(
		{ type: platform, status: "enabled" },
		{ sort: { priority: -1 }, limit: 50 },
	)
	return rows.filter((row) => {
		if (row.autoDisabled) return false
		const groups = row.groups ?? []
		return groups.length === 0 || groups.includes(group)
	})
}

function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, "")
	const tail = path.startsWith("/") ? path : "/" + path
	return base + tail
}

export async function handleTaskSubmit(
	req: Request,
	options: TaskSubmitOptions,
): Promise<Response> {
	const dialect = options.platform === "midjourney" ? "midjourney" : "openai"
	let requestId = ""
	try {
		const auth = await authenticate(req)
		requestId = auth.requestId
		const identity = auth.identity
		const startedAt = auth.startedAt || nowMs()

		// The platform name is the entitlement and pricing key, so a token can be
		// scoped to chat models without gaining image generation.
		const model = options.platform
		assertModelAllowed(identity, model)

		const directives = effectiveDirectives(auth)
		const group =
			identity.role === "user" ? identity.group : directives.group || identity.group

		await enforceRequestLimits(identity, auth.ipHash)
		await enforceSuccessWindow(identity, requestId)

		const rawBytes = await readLimitedBytes(req.body, config.maxRequestBodyBytes, { signal: req.signal })
		const contentType = req.headers.get("content-type") ?? "application/json"
		const prepared = await prepareTaskBody(rawBytes, contentType, identity, options.platform)
		const bytes = prepared.bytes
		const available = await candidateChannels(options.platform, group)
		if (!available.length) throw noChannelAvailable(model, group)
		const candidates = available.filter((channel) =>
			isTaskSubmitPathAllowed(channel, options.platform, options.path) &&
			(!prepared.channelId || channel._id === prepared.channelId))
		if (!candidates.length) throw forbidden("this task submission path or reference channel is not allowed")

		const billedModel = billedModelFor(model, model)
		const { pricing, groupRatio } = await resolvePricing(billedModel, group)
		const estimate = Math.max(1, Math.ceil(bytes.byteLength / 4))
		const usage = { ...EMPTY_USAGE, promptTokens: Math.min(estimate, 8192) }
		const quota = computeQuota(usage, pricing, groupRatio, billedModel).quota

		await reserveQuota(identity, requestId, Math.max(preConsumedQuota(), quota))
		let reserved = true

		try {
			const attempts = Math.min(candidates.length, Math.max(1, options.maxChannels ?? 3))
			let response: Response | null = null
			let used: ChannelDoc | null = null
			let lastError: unknown = null
			let usedSecret = ""
			let usedKeyId = ""

			for (let index = 0; index < attempts; index += 1) {
				const channel = candidates[index]
				if (!channel) break
				let sent = false
				try {
					const key = prepared.channelKeyId
						? await selectChannelKey(channel._id, prepared.channelKeyId) : await pickChannelKey(channel._id)
					const headers = buildUpstreamHeaders({
						clientHeaders: req.headers,
						authHeaders: providerAuthHeaders(channel.type, key.secret),
						channelHeaders: channel.headers,
						contentType,
					})
					sent = true
					const attempt = await upstreamFetch(
						joinUrl(channel.baseUrl, options.path),
						{ method: "POST", headers, body: bytes as unknown as BodyInit },
						{
							signal: req.signal,
							headerTimeoutMs: config.upstreamHeaderTimeoutMs,
							maxBytes: config.maxUpstreamResponseBytes,
						},
					)
					if (!attempt.ok) {
						const detail = await readCappedText(attempt).catch(() => "")
						throw fromUpstream(attempt.status, sanitizeProviderError(detail, key.secret), channel._id)
					}
					response = attempt
					used = channel
					usedSecret = key.secret
					usedKeyId = key.keyId
					break
				} catch (cause) {
					lastError = cause
					// Task creation is not idempotent. An ambiguous transport
					// failure must not submit/bill the same job to another channel.
					if (sent) break
				}
			}

			if (!response || !used) {
				throw GatewayError.from(lastError ?? noChannelAvailable(model, group))
			}
			reserved = false
			await finalizeQuota(identity, requestId, quota)

			const text = await readCappedText(response)
			const payload = asRecord(redactProviderValue(parseJsonObject(text), usedSecret))
			const upstreamTaskId = extractUpstreamTaskId(payload)

			const task = await createTask({
				platform: options.platform,
				action: options.action,
				userId: identity.userId,
				tokenId: identity.tokenId,
				channelId: used._id,
				channelKeyId: usedKeyId,
				model,
				quota,
				properties: { bytes: bytes.byteLength, contentType },
			})

			if (upstreamTaskId) {
				await markSubmitted(task.taskId, upstreamTaskId)
			} else {
				// Nothing to poll. Whatever came back is the whole result.
				await updateTask(task.taskId, {
					status: "success",
					progress: "100%",
					finishTime: new Date(),
					result: payload,
				})
			}

			await recordUsage(
				{
					requestId,
					userId: identity.userId,
					tokenId: identity.tokenId,
					channelId: used._id,
					group,
					model,
					mappedModel: model,
					billedModel,
					endpoint: options.endpoint ?? "images.generations",
					dialect: "openai",
					stream: false,
					usage,
					quota,
					elapsedMs: nowMs() - startedAt,
					retries: 0,
					status: "success",
					httpStatus: 200,
					ipHash: auth.ipHash,
				},
				{ buffered: true },
			).catch(() => {})

			const rewritten = upstreamTaskId
				? (rewriteTaskId(payload, upstreamTaskId, task.taskId) as Record<string, unknown>)
				: payload
			rewritten.task_id = task.taskId

			const headers = filterDownstreamHeaders(response.headers)
			headers.set("content-type", "application/json")
			headers.set("x-request-id", requestId)
			return new Response(JSON.stringify(rewritten), { status: 200, headers })
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
					endpoint: options.endpoint ?? "images.generations",
					dialect: "openai",
					stream: false,
					quota: reserved ? 0 : quota,
					elapsedMs: nowMs() - startedAt,
					status: "error",
					errorCode: gatewayError.code,
					httpStatus: gatewayError.status,
					ipHash: auth.ipHash,
				},
				{ buffered: true },
			).catch(() => {})
			throw gatewayError
		}
	} catch (error) {
		return errorResponse(GatewayError.from(error), dialect, { requestId })
	}
}

export async function handleTaskFetch(
	req: Request,
	taskId: string,
	view: "openai" | "midjourney",
): Promise<Response> {
	let requestId = ""
	try {
		const auth = await authenticate(req)
		requestId = auth.requestId
		await enforceRequestLimits(auth.identity, auth.ipHash)
		const doc = await requireTask(taskId, auth.identity)
		const body = view === "midjourney" ? mjTaskView(doc) : publicTask(doc)
		return jsonResponse(body, { requestId })
	} catch (error) {
		return errorResponse(GatewayError.from(error), view, { requestId })
	}
}

export async function handleTaskList(req: Request): Promise<Response> {
	let requestId = ""
	try {
		const auth = await authenticate(req)
		requestId = auth.requestId
		await enforceRequestLimits(auth.identity, auth.ipHash)
		const url = new URL(req.url)
		const rawLimit = Number(url.searchParams.get("limit") ?? "50")
		const rows = await listTasks(auth.identity, {
			limit: Number.isFinite(rawLimit) ? rawLimit : 50,
		})
		return jsonResponse({ object: "list", data: rows.map(publicTask) }, { requestId })
	} catch (error) {
		return errorResponse(GatewayError.from(error), "openai", { requestId })
	}
}
