/**
 * Dialect dispatch.
 *
 * A request arrives in one dialect and a channel speaks another. This module
 * owns the mapping between the two: which wire format a channel type uses,
 * what path and auth header that provider expects, and which converter to run
 * in each direction.
 *
 * Keeping this in one place is what makes the matrix auditable. The
 * alternative - a switch on channel.type inside each route - is where the
 * combinations quietly stop matching.
 */

import { config } from "../config/env.ts"
import { notImplemented } from "../http/errors.ts"
import { asRecord, asString } from "../util/json.ts"
import type { ChannelDoc } from "../db/types.ts"
import type { SseEvent } from "./sse.ts"

import {
	anthropicToOpenaiRequest,
	anthropicToOpenaiResponse,
	createAnthropicStreamTranslator,
	openaiToAnthropicRequest,
	openaiToAnthropicResponse,
} from "./anthropic.ts"
import {
	createGeminiStreamTranslator,
	geminiToOpenaiRequest,
	geminiToOpenaiResponse,
	openaiToGeminiRequest,
	openaiToGeminiResponse,
} from "./gemini.ts"
import {
	createOpenaiStreamTranslator,
	openaiResponsePassthrough,
	usageFromOpenai,
} from "./openai.ts"

export * from "./sse.ts"
export * from "./openai.ts"
export * from "./anthropic.ts"
export * from "./gemini.ts"

/** The wire formats the gateway can speak. */
export type Dialect = "openai" | "anthropic" | "gemini"

/** Logical operations, independent of any provider's URL layout. */
export type Endpoint =
	| "chat"
	| "completions"
	| "embeddings"
	| "models"
	| "countTokens"
	| "images.generations"
	| "images.edits"
	| "audio.speech"
	| "audio.transcriptions"
	| "audio.translations"
	| "moderations"
	| "rerank"

/**
 * Channel type -> wire dialect.
 *
 * Most vendors ship an OpenAI-compatible surface, which is why the list is so
 * lopsided. Anything genuinely different is named explicitly, and anything
 * unknown is refused rather than guessed at: sending an OpenAI body to a
 * provider that does not speak it produces a confusing upstream 400 that
 * looks like a gateway fault.
 */
export function dialectFor(channelType: string): Dialect {
	switch (channelType) {
		case "anthropic":
			return "anthropic"
		case "gemini":
		case "vertex":
			return "gemini"
		case "openai":
		case "azure":
		case "deepseek":
		case "moonshot":
		case "zhipu":
		case "qwen":
		case "baidu":
		case "xai":
		case "groq":
		case "mistral":
		case "cohere":
		case "openrouter":
		case "ollama":
			return "openai"
		default:
			throw notImplemented(`channel type "${channelType}" has no chat dialect`)
	}
}

function trimSlash(value: string): string {
	return value.replace(/\/+$/, "")
}

/**
 * Builds the upstream URL.
 *
 * Providers disagree about where the model goes: OpenAI puts it in the body,
 * Gemini puts it in the path, and Azure puts a deployment name in the path
 * with the API version as a query parameter.
 */
export function upstreamUrlFor(
	channel: Pick<ChannelDoc, "type" | "baseUrl" | "config">,
	options: { endpoint: Endpoint; model: string; stream?: boolean },
): string {
	const base = trimSlash(channel.baseUrl)
	const { endpoint, model, stream } = options

	if (channel.type === "azure") {
		const settings = asRecord(channel.config)
		const apiVersion = asString(settings.apiVersion) || config.azureDefaultApiVersion
		// Azure addresses a deployment, which need not share the model's name.
		const deployment = asString(asRecord(settings.deployments)[model]) || model
		const suffix = azureSuffix(endpoint)
		return `${base}/openai/deployments/${encodeURIComponent(deployment)}${suffix}?api-version=${encodeURIComponent(apiVersion)}`
	}

	if (dialectFor(channel.type) === "gemini") {
		const method =
			endpoint === "embeddings"
				? "embedContent"
				: endpoint === "countTokens"
					? "countTokens"
					: stream
						? "streamGenerateContent"
						: "generateContent"
		if (endpoint === "models") return `${base}/v1beta/models`
		// alt=sse asks for event framing instead of a JSON array, which cannot
		// be consumed incrementally.
		const query = method === "streamGenerateContent" ? "?alt=sse" : ""
		return `${base}/v1beta/models/${encodeURIComponent(model)}:${method}${query}`
	}

	if (dialectFor(channel.type) === "anthropic") {
		if (endpoint === "countTokens") return `${base}/v1/messages/count_tokens`
		if (endpoint === "models") return `${base}/v1/models`
		return `${base}/v1/messages`
	}

	return `${base}${openaiSuffix(endpoint)}`
}

function openaiSuffix(endpoint: Endpoint): string {
	switch (endpoint) {
		case "chat":
			return "/v1/chat/completions"
		case "completions":
			return "/v1/completions"
		case "embeddings":
			return "/v1/embeddings"
		case "models":
			return "/v1/models"
		case "images.generations":
			return "/v1/images/generations"
		case "images.edits":
			return "/v1/images/edits"
		case "audio.speech":
			return "/v1/audio/speech"
		case "audio.transcriptions":
			return "/v1/audio/transcriptions"
		case "audio.translations":
			return "/v1/audio/translations"
		case "moderations":
			return "/v1/moderations"
		case "rerank":
			return "/v1/rerank"
		case "countTokens":
			return "/v1/chat/completions"
		default:
			return "/v1/chat/completions"
	}
}

function azureSuffix(endpoint: Endpoint): string {
	switch (endpoint) {
		case "embeddings":
			return "/embeddings"
		case "completions":
			return "/completions"
		case "images.generations":
			return "/images/generations"
		case "audio.speech":
			return "/audio/speech"
		case "audio.transcriptions":
			return "/audio/transcriptions"
		default:
			return "/chat/completions"
	}
}

/**
 * The provider-specific authentication header.
 *
 * Only the header is produced here. Building the full header set, including
 * stripping anything the client tried to smuggle through, stays in
 * lib/http/headers.ts so there is one place that decides what leaves.
 */
export function providerAuthHeaders(channelType: string, secret: string): Record<string, string> {
	switch (dialectFor(channelType)) {
		case "anthropic":
			return {
				"x-api-key": secret,
				"anthropic-version": config.anthropicVersion,
			}
		case "gemini":
			return { "x-goog-api-key": secret }
		default:
			// Azure authenticates with its own header rather than a bearer token.
			return channelType === "azure"
				? { "api-key": secret }
				: { authorization: `Bearer ${secret}` }
	}
}

/**
 * Converts a request body from the dialect the client used into the one the
 * channel speaks. Same-dialect pairs are returned unchanged.
 */
export function transformRequest(args: {
	from: Dialect
	to: Dialect
	body: unknown
	model: string
}): Record<string, unknown> {
	const { from, to, body, model } = args

	// Everything routes through the OpenAI shape as the intermediate form, so
	// adding a dialect costs two converters rather than one per pair.
	const canonical =
		from === "openai"
			? asRecord(body)
			: from === "anthropic"
				? anthropicToOpenaiRequest(body)
				: geminiToOpenaiRequest(body, model)

	switch (to) {
		case "openai":
			return { ...canonical, model }
		case "anthropic":
			return { ...openaiToAnthropicRequest({ ...canonical, model }), model }
		case "gemini":
			// The model travels in the path, not the body.
			return openaiToGeminiRequest({ ...canonical, model })
	}
}

/** Converts a buffered upstream response back into the client's dialect. */
export function transformResponse(args: {
	from: Dialect
	to: Dialect
	body: unknown
	requestedModel: string
}): Record<string, unknown> {
	const { from, to, body, requestedModel } = args

	const canonical =
		from === "openai"
			? openaiResponsePassthrough(body, requestedModel)
			: from === "anthropic"
				? anthropicToOpenaiResponse(body, requestedModel)
				: geminiToOpenaiResponse(body, requestedModel)

	switch (to) {
		case "openai":
			return canonical
		case "anthropic":
			return openaiToAnthropicResponse(canonical, requestedModel)
		case "gemini":
			return openaiToGeminiResponse(canonical, requestedModel)
	}
}

export type AnyStreamTranslator = {
	handle: (event: SseEvent) => Array<Record<string, unknown>>
	usage: () => Record<string, unknown>
	done: () => boolean
}

/**
 * Builds the translator for an upstream stream.
 *
 * The result always produces OpenAI-shaped chunks. Re-framing those into the
 * client's dialect happens in the relay, which is the only place that knows
 * how the response is being written.
 */
export function createStreamTranslator(args: {
	from: Dialect
	model: string
	id?: string
	suppressUsageFrame?: boolean
}): AnyStreamTranslator {
	switch (args.from) {
		case "anthropic":
			return createAnthropicStreamTranslator({ model: args.model, id: args.id })
		case "gemini":
			return createGeminiStreamTranslator({ model: args.model, id: args.id })
		case "openai":
			return createOpenaiStreamTranslator({
				model: args.model,
				suppressUsageFrame: args.suppressUsageFrame,
			})
	}
}

/** Reads a usage block out of a buffered response in any dialect. */
export function usageFromResponse(dialect: Dialect, body: unknown): Record<string, unknown> {
	const record = asRecord(body)
	switch (dialect) {
		case "anthropic":
			return usageFromOpenai(asRecord(anthropicToOpenaiResponse(record)).usage)
		case "gemini":
			return usageFromOpenai(asRecord(geminiToOpenaiResponse(record)).usage)
		default:
			return usageFromOpenai(record.usage)
	}
}
