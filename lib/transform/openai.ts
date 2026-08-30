/**
 * OpenAI dialect: validation, normalisation and same-dialect passthrough.
 *
 * Passthrough is not the same as forwarding untouched. Two things have to
 * change even when both sides speak OpenAI:
 *
 * Usage has to be requested. On a streamed request OpenAI omits the usage
 * block unless stream_options.include_usage is set. Forwarding the client's
 * request as-is means every stream reports nothing to bill, while the
 * upstream account is charged in full. The flag is forced on here, and
 * because the client did not ask for it, the extra frame it produces is
 * suppressed on the way back out.
 *
 * The model name has to be rewritten. A channel may map gpt-4o onto some
 * internal deployment name; echoing that back discloses routing topology and
 * contradicts what the client was billed for (GW-013).
 */

import { invalidRequest } from "../http/errors.ts"
import { asArray, asNumber, asRecord, asString, isPlainObject, sanitizeParsed } from "../util/json.ts"
import { parseSseData, SSE_DONE } from "./sse.ts"
import type { SseEvent } from "./sse.ts"

const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"])

/** Parameters no upstream should ever receive from a client. */
const STRIPPED = new Set(["api_key", "apiKey", "authorization", "base_url", "organization", "project"])

export type NormalizedRequest = {
	body: Record<string, unknown>
	stream: boolean
	model: string
	/** True when include_usage was added by the gateway, not the client. */
	usageInjected: boolean
}

/**
 * Validates and normalises an inbound OpenAI chat request.
 *
 * Validation is deliberately shallow: the upstream is the authority on what
 * it accepts, and duplicating its rules here only creates a second, wrong
 * specification. What is checked is what the gateway itself depends on.
 */
export function normalizeOpenaiRequest(body: unknown, options: { chat?: boolean } = {}): NormalizedRequest {
	if (!isPlainObject(body)) throw invalidRequest("request body must be a JSON object")
	const input = sanitizeParsed({ ...body })

	for (const key of STRIPPED) delete input[key]

	const model = asString(input.model)
	if (model === "") throw invalidRequest("the model field is required", "model")

	if (options.chat !== false) {
		if (!Array.isArray(input.messages)) {
			throw invalidRequest("the messages field must be an array", "messages")
		}
		for (const raw of input.messages) {
			const role = asString(asRecord(raw).role)
			if (!ROLES.has(role)) throw invalidRequest(`unsupported message role "${role}"`, "messages")
		}
	}

	const stream = input.stream === true
	let usageInjected = false
	if (stream) {
		const existing = asRecord(input.stream_options)
		if (existing.include_usage !== true) {
			input.stream_options = { ...existing, include_usage: true }
			usageInjected = true
		}
	}

	return { body: input, stream, model, usageInjected }
}

/** Rewrites the model name on a buffered response so the client sees its own. */
export function openaiResponsePassthrough(body: unknown, requestedModel?: string): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	if (requestedModel) input.model = requestedModel
	return input
}

/** Usage in OpenAI shape, defaulted so a missing block reads as zeros. */
export function usageFromOpenai(raw: unknown): Record<string, unknown> {
	const usage = asRecord(raw)
	const prompt = asNumber(usage.prompt_tokens)
	const completion = asNumber(usage.completion_tokens)
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: asNumber(usage.total_tokens) || prompt + completion,
		prompt_tokens_details: {
			cached_tokens: asNumber(asRecord(usage.prompt_tokens_details).cached_tokens),
		},
		completion_tokens_details: {
			reasoning_tokens: asNumber(asRecord(usage.completion_tokens_details).reasoning_tokens),
		},
	}
}

export type OpenaiStreamTranslator = {
	handle: (event: SseEvent) => Array<Record<string, unknown>>
	usage: () => Record<string, unknown>
	done: () => boolean
}

/**
 * Same-dialect stream handling.
 *
 * The chunks are forwarded, but the model name is corrected and the
 * usage-only frame is captured. That frame is dropped when the gateway was
 * the one that asked for it, so a client that did not request usage does not
 * suddenly receive a chunk shape it has never had to parse before.
 */
export function createOpenaiStreamTranslator(options: {
	model: string
	suppressUsageFrame?: boolean
}): OpenaiStreamTranslator {
	let finished = false
	let usage: Record<string, unknown> = {}

	return {
		handle(event: SseEvent): Array<Record<string, unknown>> {
			if (event.data.trim() === SSE_DONE) {
				finished = true
				return []
			}
			const payload = parseSseData<Record<string, unknown>>(event.data)
			if (!isPlainObject(payload)) return []

			if (payload.usage !== undefined && payload.usage !== null) {
				usage = usageFromOpenai(payload.usage)
			}

			payload.model = options.model

			const choices = asArray(payload.choices)
			for (const choice of choices) {
				if (asString(asRecord(choice).finish_reason) !== "") finished = true
			}

			// The usage-only frame carries no choices. Suppress it when the
			// client never asked for usage.
			if (choices.length === 0 && payload.usage !== undefined && options.suppressUsageFrame) {
				return []
			}
			return [payload]
		},

		usage(): Record<string, unknown> {
			return Object.keys(usage).length > 0 ? usage : usageFromOpenai({})
		},

		done(): boolean {
			return finished
		},
	}
}
