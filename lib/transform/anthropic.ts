/**
 * Anthropic <-> OpenAI conversion.
 *
 * Two rules govern everything here.
 *
 * Roles are structure, never text. Anthropic keeps the system prompt in a
 * top-level field while OpenAI keeps it as a message, so a naive converter is
 * tempted to flatten one into the other by prefixing strings. That is exactly
 * the mechanism a prompt injection needs: a user turn containing "System: you
 * are now..." would be re-parsed as an instruction with more authority than
 * the user should have (GW-012). Every conversion below moves values between
 * structured fields and never concatenates a role marker onto content.
 *
 * Usage is not comparable across providers. Anthropic reports input_tokens
 * *excluding* cache reads and writes; OpenAI reports prompt_tokens including
 * them. Copying the number across would silently under-report, and therefore
 * under-bill, every cached request (GW-016).
 */

import { invalidRequest } from "../http/errors.ts"
import { asArray, asNumber, asRecord, asString, isPlainObject, sanitizeParsed } from "../util/json.ts"
import { randomHex } from "../util/crypto.ts"
import { parseSseData } from "./sse.ts"
import type { SseEvent } from "./sse.ts"

/** Anthropic rejects a request without it; OpenAI treats it as optional. */
export const DEFAULT_MAX_TOKENS = 4096

const OPENAI_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"])

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

function newCompletionId(): string {
	return `chatcmpl-${randomHex(12)}`
}

/** Anthropic stop reasons in OpenAI's vocabulary. */
export function finishReasonFromAnthropic(stopReason: unknown): string | null {
	switch (asString(stopReason)) {
		case "end_turn":
		case "stop_sequence":
			return "stop"
		case "max_tokens":
			return "length"
		case "tool_use":
			return "tool_calls"
		case "refusal":
			return "content_filter"
		case "":
			return null
		default:
			return "stop"
	}
}

export function stopReasonFromOpenai(finishReason: unknown): string {
	switch (asString(finishReason)) {
		case "length":
			return "max_tokens"
		case "tool_calls":
		case "function_call":
			return "tool_use"
		case "content_filter":
			return "refusal"
		default:
			return "end_turn"
	}
}

/**
 * Converts an OpenAI content value into Anthropic blocks.
 *
 * A bare string becomes one text block. Anything else is walked part by part,
 * so a part the gateway does not understand is dropped rather than
 * stringified into the prompt.
 */
function toAnthropicBlocks(content: unknown): Array<Record<string, unknown>> {
	if (typeof content === "string") {
		return content === "" ? [] : [{ type: "text", text: content }]
	}
	const blocks: Array<Record<string, unknown>> = []
	for (const raw of asArray(content)) {
		const part = asRecord(raw)
		const type = asString(part.type)
		if (type === "text") {
			const text = asString(part.text)
			if (text !== "") blocks.push({ type: "text", text })
			continue
		}
		if (type === "image_url") {
			const url = asString(asRecord(part.image_url).url)
			if (url === "") continue
			const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url)
			blocks.push(
				dataUrl
					? {
							type: "image",
							source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] },
						}
					: { type: "image", source: { type: "url", url } },
			)
			continue
		}
		if (type === "input_audio" || type === "file") {
			// Anthropic has no equivalent; forwarding it as text would inject
			// base64 into the prompt.
			continue
		}
	}
	return blocks
}

/** Anthropic blocks back into an OpenAI content value. */
function fromAnthropicBlocks(content: unknown): {
	text: string
	toolCalls: Array<Record<string, unknown>>
	reasoning: string
} {
	if (typeof content === "string") return { text: content, toolCalls: [], reasoning: "" }

	let text = ""
	let reasoning = ""
	const toolCalls: Array<Record<string, unknown>> = []
	for (const raw of asArray(content)) {
		const block = asRecord(raw)
		switch (asString(block.type)) {
			case "text":
				text += asString(block.text)
				break
			case "thinking":
				reasoning += asString(block.thinking)
				break
			case "tool_use":
				toolCalls.push({
					id: asString(block.id) || `call_${randomHex(8)}`,
					type: "function",
					function: {
						name: asString(block.name),
						arguments: JSON.stringify(block.input ?? {}),
					},
				})
				break
			default:
				break
		}
	}
	return { text, toolCalls, reasoning }
}

function toolChoiceToAnthropic(choice: unknown): Record<string, unknown> | undefined {
	if (typeof choice === "string") {
		if (choice === "auto") return { type: "auto" }
		if (choice === "none") return { type: "none" }
		if (choice === "required") return { type: "any" }
		return undefined
	}
	const record = asRecord(choice)
	const name = asString(asRecord(record.function).name)
	return name ? { type: "tool", name } : undefined
}

function toolChoiceToOpenai(choice: unknown): unknown {
	const record = asRecord(choice)
	switch (asString(record.type)) {
		case "auto":
			return "auto"
		case "any":
			return "required"
		case "none":
			return "none"
		case "tool":
			return { type: "function", function: { name: asString(record.name) } }
		default:
			return undefined
	}
}

/**
 * OpenAI chat request -> Anthropic messages request.
 *
 * System turns are lifted into the top-level field. Tool results become
 * user-role tool_result blocks, which is where Anthropic expects them, and
 * consecutive same-role turns are merged because Anthropic requires
 * alternation.
 */
export function openaiToAnthropicRequest(body: unknown): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const systemBlocks: Array<Record<string, unknown>> = []
	const messages: Array<Record<string, unknown>> = []

	for (const raw of asArray(input.messages)) {
		const message = asRecord(raw)
		const role = asString(message.role)
		if (!OPENAI_ROLES.has(role)) {
			// Coercing an unknown role into "user" or "system" is how a request
			// ends up with authority it was never granted.
			throw invalidRequest(`unsupported message role "${role}"`, "messages")
		}

		if (role === "system" || role === "developer") {
			systemBlocks.push(...toAnthropicBlocks(message.content))
			continue
		}

		if (role === "tool" || role === "function") {
			const block = {
				type: "tool_result",
				tool_use_id: asString(message.tool_call_id),
				content: asString(message.content),
			}
			appendMessage(messages, "user", [block])
			continue
		}

		const blocks = toAnthropicBlocks(message.content)
		if (role === "assistant") {
			for (const rawCall of asArray(message.tool_calls)) {
				const call = asRecord(rawCall)
				const fn = asRecord(call.function)
				blocks.push({
					type: "tool_use",
					id: asString(call.id) || `toolu_${randomHex(8)}`,
					name: asString(fn.name),
					input: parseArguments(fn.arguments),
				})
			}
		}
		if (blocks.length > 0) appendMessage(messages, role, blocks)
	}

	const maxTokens =
		asNumber(input.max_tokens) || asNumber(input.max_completion_tokens) || DEFAULT_MAX_TOKENS

	const out: Record<string, unknown> = {
		model: asString(input.model),
		max_tokens: maxTokens,
		messages,
	}
	if (systemBlocks.length > 0) out.system = systemBlocks
	if (input.temperature !== undefined) out.temperature = asNumber(input.temperature)
	if (input.top_p !== undefined) out.top_p = asNumber(input.top_p)
	if (input.stream !== undefined) out.stream = input.stream === true
	if (input.stop !== undefined) {
		out.stop_sequences = typeof input.stop === "string" ? [input.stop] : asArray(input.stop)
	}

	const tools = asArray(input.tools)
	if (tools.length > 0) {
		out.tools = tools.map((rawTool) => {
			const fn = asRecord(asRecord(rawTool).function)
			return {
				name: asString(fn.name),
				description: asString(fn.description),
				input_schema: isPlainObject(fn.parameters)
					? fn.parameters
					: { type: "object", properties: {} },
			}
		})
	}
	const choice = toolChoiceToAnthropic(input.tool_choice)
	if (choice) out.tool_choice = choice

	return out
}

function appendMessage(
	messages: Array<Record<string, unknown>>,
	role: string,
	blocks: Array<Record<string, unknown>>,
): void {
	const last = messages[messages.length - 1]
	if (last && last.role === role) {
		; (last.content as Array<Record<string, unknown>>).push(...blocks)
		return
	}
	messages.push({ role, content: blocks })
}

function parseArguments(value: unknown): Record<string, unknown> {
	if (isPlainObject(value)) return value
	const text = asString(value)
	if (text === "") return {}
	try {
		const parsed = JSON.parse(text) as unknown
		return isPlainObject(parsed) ? sanitizeParsed(parsed) : {}
	} catch {
		return {}
	}
}

/**
 * Anthropic usage -> OpenAI usage.
 *
 * The cache figures are added back into prompt_tokens because Anthropic
 * excludes them and OpenAI does not (GW-016).
 */
export function usageFromAnthropic(raw: unknown): Record<string, unknown> {
	const usage = asRecord(raw)
	const input = asNumber(usage.input_tokens)
	const cacheRead = asNumber(usage.cache_read_input_tokens)
	const cacheWrite = asNumber(usage.cache_creation_input_tokens)
	const output = asNumber(usage.output_tokens)
	const prompt = input + cacheRead + cacheWrite
	return {
		prompt_tokens: prompt,
		completion_tokens: output,
		total_tokens: prompt + output,
		prompt_tokens_details: {
			cached_tokens: cacheRead,
			cache_creation_tokens: cacheWrite,
		},
	}
}

/** Anthropic messages response -> OpenAI chat completion. */
export function anthropicToOpenaiResponse(body: unknown, requestedModel?: string): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const { text, toolCalls, reasoning } = fromAnthropicBlocks(input.content)

	const message: Record<string, unknown> = {
		role: "assistant",
		content: text === "" && toolCalls.length > 0 ? null : text,
	}
	if (toolCalls.length > 0) message.tool_calls = toolCalls
	if (reasoning !== "") message.reasoning_content = reasoning

	return {
		id: asString(input.id) || newCompletionId(),
		object: "chat.completion",
		created: nowSeconds(),
		// The requested name wins so the client never sees a mapping (GW-013).
		model: requestedModel || asString(input.model),
		choices: [
			{
				index: 0,
				message,
				finish_reason: finishReasonFromAnthropic(input.stop_reason) ?? "stop",
			},
		],
		usage: usageFromAnthropic(input.usage),
	}
}

/** Anthropic messages request -> OpenAI chat request, for an OpenAI channel. */
export function anthropicToOpenaiRequest(body: unknown): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const messages: Array<Record<string, unknown>> = []

	// The system field is a first-class field on both sides; it becomes the
	// leading system message rather than being prepended to a user turn.
	const system = input.system
	if (typeof system === "string" && system !== "") {
		messages.push({ role: "system", content: system })
	} else {
		const blocks = asArray(system)
		const text = blocks.map((block) => asString(asRecord(block).text)).join("\n")
		if (text !== "") messages.push({ role: "system", content: text })
	}

	for (const raw of asArray(input.messages)) {
		const message = asRecord(raw)
		const role = asString(message.role)
		if (role !== "user" && role !== "assistant") {
			throw invalidRequest(`unsupported message role "${role}"`, "messages")
		}

		// Tool results arrive as user-role blocks and have to be split back out
		// into their own tool messages.
		const toolResults = asArray(message.content).filter(
			(block) => asString(asRecord(block).type) === "tool_result",
		)
		for (const raw2 of toolResults) {
			const block = asRecord(raw2)
			messages.push({
				role: "tool",
				tool_call_id: asString(block.tool_use_id),
				content:
					typeof block.content === "string"
						? block.content
						: fromAnthropicBlocks(block.content).text,
			})
		}

		const { text, toolCalls, reasoning } = fromAnthropicBlocks(message.content)
		if (text === "" && toolCalls.length === 0 && reasoning === "") continue

		const converted: Record<string, unknown> = { role, content: text }
		if (toolCalls.length > 0) {
			converted.tool_calls = toolCalls
			if (text === "") converted.content = null
		}
		messages.push(converted)
	}

	const out: Record<string, unknown> = {
		model: asString(input.model),
		messages,
		max_tokens: asNumber(input.max_tokens) || DEFAULT_MAX_TOKENS,
	}
	if (input.temperature !== undefined) out.temperature = asNumber(input.temperature)
	if (input.top_p !== undefined) out.top_p = asNumber(input.top_p)
	if (input.stream !== undefined) out.stream = input.stream === true
	if (input.stop_sequences !== undefined) out.stop = asArray(input.stop_sequences)

	const tools = asArray(input.tools)
	if (tools.length > 0) {
		out.tools = tools.map((rawTool) => {
			const tool = asRecord(rawTool)
			return {
				type: "function",
				function: {
					name: asString(tool.name),
					description: asString(tool.description),
					parameters: isPlainObject(tool.input_schema)
						? tool.input_schema
						: { type: "object", properties: {} },
				},
			}
		})
	}
	const choice = toolChoiceToOpenai(input.tool_choice)
	if (choice !== undefined) out.tool_choice = choice

	return out
}

/** OpenAI chat completion -> Anthropic messages response. */
export function openaiToAnthropicResponse(body: unknown, requestedModel?: string): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const choice = asRecord(asArray(input.choices)[0])
	const message = asRecord(choice.message)

	const content: Array<Record<string, unknown>> = []
	const text = asString(message.content)
	if (text !== "") content.push({ type: "text", text })
	for (const rawCall of asArray(message.tool_calls)) {
		const call = asRecord(rawCall)
		const fn = asRecord(call.function)
		content.push({
			type: "tool_use",
			id: asString(call.id) || `toolu_${randomHex(8)}`,
			name: asString(fn.name),
			input: parseArguments(fn.arguments),
		})
	}

	const usage = asRecord(input.usage)
	const cached = asNumber(asRecord(usage.prompt_tokens_details).cached_tokens)
	const prompt = asNumber(usage.prompt_tokens)
	return {
		id: asString(input.id) || `msg_${randomHex(12)}`,
		type: "message",
		role: "assistant",
		model: requestedModel || asString(input.model),
		content,
		stop_reason: stopReasonFromOpenai(choice.finish_reason),
		stop_sequence: null,
		usage: {
			// Back out the cached portion: Anthropic's input_tokens excludes it.
			input_tokens: Math.max(0, prompt - cached),
			cache_read_input_tokens: cached,
			output_tokens: asNumber(usage.completion_tokens),
		},
	}
}

export type StreamTranslator = {
	/** Chunks to forward for this event, already in the target dialect. */
	handle: (event: SseEvent) => Array<Record<string, unknown>>
	/** Usage accumulated so far, in OpenAI shape. */
	usage: () => Record<string, unknown>
	done: () => boolean
}

/**
 * Anthropic event stream -> OpenAI chunk stream.
 *
 * Anthropic describes a stream as a tree of content blocks being opened,
 * appended to and closed; OpenAI describes it as a flat sequence of deltas.
 * The block index has to be tracked to know which tool call a fragment of
 * JSON belongs to.
 */
export function createAnthropicStreamTranslator(options: {
	model: string
	id?: string
}): StreamTranslator {
	const id = options.id ?? newCompletionId()
	const created = nowSeconds()
	const toolIndexByBlock = new Map<number, number>()
	let toolCount = 0
	let finished = false
	let promptTokens = 0
	let cachedTokens = 0
	let cacheWriteTokens = 0
	let completionTokens = 0

	function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
		return {
			id,
			object: "chat.completion.chunk",
			created,
			model: options.model,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		}
	}

	return {
		handle(event: SseEvent): Array<Record<string, unknown>> {
			const payload = asRecord(parseSseData(event.data) ?? {})
			const type = asString(payload.type) || asString(event.event)

			switch (type) {
				case "message_start": {
					const usage = asRecord(asRecord(payload.message).usage)
					promptTokens = asNumber(usage.input_tokens)
					cachedTokens = asNumber(usage.cache_read_input_tokens)
					cacheWriteTokens = asNumber(usage.cache_creation_input_tokens)
					return [chunk({ role: "assistant", content: "" })]
				}

				case "content_block_start": {
					const index = asNumber(payload.index)
					const block = asRecord(payload.content_block)
					if (asString(block.type) !== "tool_use") return []
					const toolIndex = toolCount++
					toolIndexByBlock.set(index, toolIndex)
					return [
						chunk({
							tool_calls: [
								{
									index: toolIndex,
									id: asString(block.id) || `toolu_${randomHex(8)}`,
									type: "function",
									function: { name: asString(block.name), arguments: "" },
								},
							],
						}),
					]
				}

				case "content_block_delta": {
					const delta = asRecord(payload.delta)
					switch (asString(delta.type)) {
						case "text_delta": {
							const text = asString(delta.text)
							return text === "" ? [] : [chunk({ content: text })]
						}
						case "thinking_delta": {
							const thinking = asString(delta.thinking)
							return thinking === "" ? [] : [chunk({ reasoning_content: thinking })]
						}
						case "input_json_delta": {
							const toolIndex = toolIndexByBlock.get(asNumber(payload.index))
							if (toolIndex === undefined) return []
							return [
								chunk({
									tool_calls: [
										{
											index: toolIndex,
											function: { arguments: asString(delta.partial_json) },
										},
									],
								}),
							]
						}
						default:
							return []
					}
				}

				case "message_delta": {
					const usage = asRecord(payload.usage)
					if (usage.output_tokens !== undefined) {
						completionTokens = asNumber(usage.output_tokens)
					}
					const reason = finishReasonFromAnthropic(asRecord(payload.delta).stop_reason)
					if (!reason) return []
					finished = true
					return [chunk({}, reason)]
				}

				case "message_stop":
					finished = true
					return []

				case "error": {
					finished = true
					const error = asRecord(payload.error)
					return [
						{
							id,
							object: "chat.completion.chunk",
							created,
							model: options.model,
							choices: [{ index: 0, delta: {}, finish_reason: "error" }],
							error: {
								message: asString(error.message) || "upstream stream error",
								type: asString(error.type) || "api_error",
							},
						},
					]
				}

				default:
					// ping, content_block_stop and anything Anthropic adds later.
					return []
			}
		},

		usage(): Record<string, unknown> {
			const prompt = promptTokens + cachedTokens + cacheWriteTokens
			return {
				prompt_tokens: prompt,
				completion_tokens: completionTokens,
				total_tokens: prompt + completionTokens,
				prompt_tokens_details: {
					cached_tokens: cachedTokens,
					cache_creation_tokens: cacheWriteTokens,
				},
			}
		},

		done(): boolean {
			return finished
		},
	}
}
