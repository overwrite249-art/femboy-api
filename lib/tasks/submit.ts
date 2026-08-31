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
import { GatewayError, fromUpstream, noChannelAvailable } from "../http/errors.ts"
import { errorResponse, jsonResponse } from "../http/respond.ts"
import { finalizeQuota, preConsumedQuota, releaseQuota, reserveQuota } from "../quota/index.ts"
import { enforceRequestLimits, enforceSuccessWindow } from "../ratelimit/index.ts"
import { readLimitedBytes } from "../relay/passthrough.ts"
import { pickChannelKey } from "../routing/keys.ts"
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
		const parsed: unknown = JSON.parse(text)
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
	} catch {
		// Providers are not always honest about returning JSON.
	}
	return {}
}

async function candidateChannels(platform: string, group: string): Promise<ChannelDoc[]> {
	const rows = await channels().find(
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

		const bytes = await readLimitedBytes(req.body, config.maxRequestBodyBytes)
		const contentType = req.headers.get("content-type") ?? "application/json"

		const billedModel = billedModelFor(model, model)
		const { pricing, groupRatio } = await resolvePricing(billedModel, group)
		const estimate = Math.max(1, Math.ceil(bytes.byteLength / 4))
		const usage = { ...EMPTY_USAGE, promptTokens: Math.min(estimate, 8192) }
		const quota = computeQuota(usage, pricing, groupRatio, billedModel).quota

		await reserveQuota(identity, requestId, Math.max(preConsumedQuota(), quota))
		let reserved = true

		try {
			const candidates = await candidateChannels(options.platform, group)
			if (candidates.length === 0) throw noChannelAvailable(model, group)

			const attempts = Math.min(candidates.length, Math.max(1, options.maxChannels ?? 3))
			let response: Response | null = null
			let used: ChannelDoc | null = null
			let lastError: unknown = null

			for (let index = 0; index < attempts; index += 1) {
				const channel = candidates[index]
				if (!channel) break
				try {
					const key = await pickChannelKey(channel._id)
					const headers = buildUpstreamHeaders({
						clientHeaders: req.headers,
						authHeaders: providerAuthHeaders(channel.type, key.secret),
						channelHeaders: channel.headers,
						contentType,
					})
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
						throw fromUpstream(attempt.status, detail, channel._id)
					}
					response = attempt
					used = channel
					break
				} catch (cause) {
					lastError = cause
				}
			}

			if (!response || !used) {
				throw GatewayError.from(lastError ?? noChannelAvailable(model, group))
			}

			const text = await readCappedText(response)
			const payload = parseJsonObject(text)
			const upstreamTaskId = extractUpstreamTaskId(payload)

			const task = await createTask({
				platform: options.platform,
				action: options.action,
				userId: identity.userId,
				tokenId: identity.tokenId,
				channelId: used._id,
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

			await finalizeQuota(identity, requestId, quota).catch(() => {})
			reserved = false

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
					quota: 0,
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
