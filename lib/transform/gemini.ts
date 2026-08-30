/**
 * Gemini <-> OpenAI conversion.
 *
 * Gemini differs from both other dialects in ways that matter:
 *
 * - There is no system role. Instructions live in a separate
 *   systemInstruction field, so the same structural discipline as the
 *   Anthropic converter applies - systemInstruction is only ever populated
 *   from a system-role message, never from user text (GW-012).
 * - The assistant role is called "model".
 * - Tool results are parts inside a normal turn, not a distinct role.
 * - Token accounting has two traps. promptTokenCount *includes* cached
 *   tokens, so adding them again would double count. candidatesTokenCount
 *   *excludes* thoughtsTokenCount, so ignoring it loses every reasoning token
 *   on a thinking model: the upstream charges for them and the gateway would
 *   bill nothing.
 */

import { config } from "../config/env.ts"
import { invalidRequest } from "../http/errors.ts"
import { asArray, asNumber, asRecord, asString, isPlainObject, sanitizeParsed } from "../util/json.ts"
import { randomHex } from "../util/crypto.ts"
import { parseSseData } from "./sse.ts"
import type { SseEvent } from "./sse.ts"

const OPENAI_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"])

const HARM_CATEGORIES = [
	"HARM_CATEGORY_HARASSMENT",
	"HARM_CATEGORY_HATE_SPEECH",
	"HARM_CATEGORY_SEXUALLY_EXPLICIT",
	"HARM_CATEGORY_DANGEROUS_CONTENT",
	"HARM_CATEGORY_CIVIC_INTEGRITY",
]

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

/** Gemini finish reasons in OpenAI's vocabulary. */
export function finishReasonFromGemini(reason: unknown, hasToolCall = false): string | null {
	const value = asString(reason)
	if (value === "") return null
	switch (value) {
		case "STOP":
			return hasToolCall ? "tool_calls" : "stop"
		case "MAX_TOKENS":
			return "length"
		case "SAFETY":
		case "RECITATION":
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
			return "content_filter"
		default:
			return "stop"
	}
}

export function finishReasonToGemini(reason: unknown): string {
	switch (asString(reason)) {
		case "length":
			return "MAX_TOKENS"
		case "content_filter":
			return "SAFETY"
		default:
			return "STOP"
	}
}

/** OpenAI content -> Gemini parts. */
function toGeminiParts(content: unknown): Array<Record<string, unknown>> {
	if (typeof content === "string") {
		return content === "" ? [] : [{ text: content }]
	}
	const parts: Array<Record<string, unknown>> = []
	for (const raw of asArray(content)) {
		const part = asRecord(raw)
		const type = asString(part.type)
		if (type === "text") {
			const text = asString(part.text)
			if (text !== "") parts.push({ text })
			continue
		}
		if (type === "image_url") {
			const url = asString(asRecord(part.image_url).url)
			if (url === "") continue
			const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url)
			parts.push(
				dataUrl
					? { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } }
					: { fileData: { mimeType: "image/*", fileUri: url } },
			)
		}
	}
	return parts
}

/** Gemini parts -> the pieces an OpenAI message is assembled from. */
function fromGeminiParts(parts: unknown): {
	text: string
	reasoning: string
	toolCalls: Array<Record<string, unknown>>
} {
	let text = ""
	let reasoning = ""
	const toolCalls: Array<Record<string, unknown>> = []

	for (const raw of asArray(parts)) {
		const part = asRecord(raw)
		if (part.functionCall !== undefined) {
			const call = asRecord(part.functionCall)
			toolCalls.push({
				id: `call_${randomHex(8)}`,
				type: "function",
				function: {
					name: asString(call.name),
					arguments: JSON.stringify(call.args ?? {}),
				},
			})
			continue
		}
		if (part.text !== undefined) {
			// Gemini marks reasoning with a thought flag on an ordinary text part.
			if (part.thought === true) reasoning += asString(part.text)
			else text += asString(part.text)
		}
	}
	return { text, reasoning, toolCalls }
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
 * Strips the JSON Schema keywords Gemini rejects.
 *
 * Gemini accepts a narrow subset of OpenAPI schema. Forwarding a full JSON
 * Schema produces a 400 that looks like a gateway fault, so unsupported
 * keywords are dropped here. The walk is depth-bounded because a schema is
 * user input and a self-referential one would otherwise recurse forever
 * (GW-022).
 */
export function toGeminiSchema(schema: unknown, depth = 0): Record<string, unknown> {
	if (depth > config.maxJsonDepth || !isPlainObject(schema)) return { type: "object" }

	const allowed = new Set([
		"type",
		"format",
		"description",
		"nullable",
		"enum",
		"items",
		"properties",
		"required",
	])
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(schema)) {
		if (!allowed.has(key)) continue
		if (key === "properties" && isPlainObject(value)) {
			const properties: Record<string, unknown> = {}
			for (const [name, child] of Object.entries(value)) {
				properties[name] = toGeminiSchema(child, depth + 1)
			}
			out.properties = properties
			continue
		}
		if (key === "items") {
			out.items = toGeminiSchema(value, depth + 1)
			continue
		}
		out[key] = value
	}
	if (out.type === undefined) out.type = "object"
	return out
}

function safetySettings(): Array<Record<string, unknown>> | undefined {
	if (!config.geminiSafetyOff) return undefined
	return HARM_CATEGORIES.map((category) => ({ category, threshold: "BLOCK_NONE" }))
}

/** OpenAI chat request -> Gemini generateContent request. */
export function openaiToGeminiRequest(body: unknown): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const contents: Array<Record<string, unknown>> = []
	const systemParts: Array<Record<string, unknown>> = []

	for (const raw of asArray(input.messages)) {
		const message = asRecord(raw)
		const role = asString(message.role)
		if (!OPENAI_ROLES.has(role)) {
			throw invalidRequest(`unsupported message role "${role}"`, "messages")
		}

		if (role === "system" || role === "developer") {
			systemParts.push(...toGeminiParts(message.content))
			continue
		}

		if (role === "tool" || role === "function") {
			// Gemini keys a tool result by function name, not by call id.
			const name = asString(message.name) || asString(message.tool_call_id)
			appendContent(contents, "user", [
				{
					functionResponse: {
						name,
						response: { content: asString(message.content) },
					},
				},
			])
			continue
		}

		const parts = toGeminiParts(message.content)
		if (role === "assistant") {
			for (const rawCall of asArray(message.tool_calls)) {
				const fn = asRecord(asRecord(rawCall).function)
				parts.push({
					functionCall: { name: asString(fn.name), args: parseArguments(fn.arguments) },
				})
			}
		}
		if (parts.length > 0) appendContent(contents, role === "assistant" ? "model" : "user", parts)
	}

	const generationConfig: Record<string, unknown> = {}
	if (input.temperature !== undefined) generationConfig.temperature = asNumber(input.temperature)
	if (input.top_p !== undefined) generationConfig.topP = asNumber(input.top_p)
	const maxTokens = asNumber(input.max_tokens) || asNumber(input.max_completion_tokens)
	if (maxTokens > 0) generationConfig.maxOutputTokens = maxTokens
	if (input.stop !== undefined) {
		generationConfig.stopSequences =
			typeof input.stop === "string" ? [input.stop] : asArray(input.stop)
	}
	if (asString(asRecord(input.response_format).type) === "json_object") {
		generationConfig.responseMimeType = "application/json"
	}

	const out: Record<string, unknown> = { contents }
	if (systemParts.length > 0) out.systemInstruction = { parts: systemParts }
	if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig

	const tools = asArray(input.tools)
	if (tools.length > 0) {
		out.tools = [
			{
				functionDeclarations: tools.map((rawTool) => {
					const fn = asRecord(asRecord(rawTool).function)
					return {
						name: asString(fn.name),
						description: asString(fn.description),
						parameters: toGeminiSchema(fn.parameters),
					}
				}),
			},
		]
	}

	const choice = input.tool_choice
	if (choice !== undefined) {
		const mode =
			choice === "required" ? "ANY" : choice === "none" ? "NONE" : choice === "auto" ? "AUTO" : null
		if (mode) out.toolConfig = { functionCallingConfig: { mode } }
		else {
			const name = asString(asRecord(asRecord(choice).function).name)
			if (name) {
				out.toolConfig = {
					functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] },
				}
			}
		}
	}

	const safety = safetySettings()
	if (safety) out.safetySettings = safety

	return out
}

function appendContent(
	contents: Array<Record<string, unknown>>,
	role: string,
	parts: Array<Record<string, unknown>>,
): void {
	const last = contents[contents.length - 1]
	if (last && last.role === role) {
		; (last.parts as Array<Record<string, unknown>>).push(...parts)
		return
	}
	contents.push({ role, parts })
}

/**
 * Gemini usage -> OpenAI usage.
 *
 * promptTokenCount already includes cached tokens, so they are reported as a
 * detail and not added again. Reasoning is the opposite: thoughtsTokenCount
 * sits outside candidatesTokenCount and has to be added or it is billed as
 * zero.
 */
export function usageFromGemini(raw: unknown): Record<string, unknown> {
	const usage = asRecord(raw)
	const prompt = asNumber(usage.promptTokenCount)
	const cached = asNumber(usage.cachedContentTokenCount)
	const reasoning = asNumber(usage.thoughtsTokenCount)
	const completion = asNumber(usage.candidatesTokenCount) + reasoning
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		prompt_tokens_details: { cached_tokens: cached },
		completion_tokens_details: { reasoning_tokens: reasoning },
	}
}

/** Gemini generateContent response -> OpenAI chat completion. */
export function geminiToOpenaiResponse(body: unknown, requestedModel?: string): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const candidates = asArray(input.candidates)

	// A prompt blocked before generation returns no candidates at all.
	if (candidates.length === 0) {
		const blockReason = asString(asRecord(input.promptFeedback).blockReason)
		return {
			id: `chatcmpl-${randomHex(12)}`,
			object: "chat.completion",
			created: nowSeconds(),
			model: requestedModel || asString(input.modelVersion),
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "" },
					finish_reason: blockReason === "" ? "stop" : "content_filter",
				},
			],
			usage: usageFromGemini(input.usageMetadata),
		}
	}

	const choices = candidates.map((rawCandidate, index) => {
		const candidate = asRecord(rawCandidate)
		const { text, reasoning, toolCalls } = fromGeminiParts(asRecord(candidate.content).parts)
		const message: Record<string, unknown> = {
			role: "assistant",
			content: text === "" && toolCalls.length > 0 ? null : text,
		}
		if (toolCalls.length > 0) message.tool_calls = toolCalls
		if (reasoning !== "") message.reasoning_content = reasoning
		return {
			index: asNumber(candidate.index) || index,
			message,
			finish_reason: finishReasonFromGemini(candidate.finishReason, toolCalls.length > 0) ?? "stop",
		}
	})

	return {
		id: `chatcmpl-${randomHex(12)}`,
		object: "chat.completion",
		created: nowSeconds(),
		// GW-013: the client is told the model it asked for.
		model: requestedModel || asString(input.modelVersion),
		choices,
		usage: usageFromGemini(input.usageMetadata),
	}
}

/** Gemini generateContent request -> OpenAI chat request. */
export function geminiToOpenaiRequest(body: unknown, model: string): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const messages: Array<Record<string, unknown>> = []

	const systemText = asArray(asRecord(input.systemInstruction).parts)
		.map((part) => asString(asRecord(part).text))
		.filter((text) => text !== "")
		.join("\n")
	if (systemText !== "") messages.push({ role: "system", content: systemText })

	for (const raw of asArray(input.contents)) {
		const content = asRecord(raw)
		const geminiRole = asString(content.role)
		if (geminiRole !== "" && geminiRole !== "user" && geminiRole !== "model") {
			throw invalidRequest(`unsupported content role "${geminiRole}"`, "contents")
		}
		const role = geminiRole === "model" ? "assistant" : "user"

		// Function responses become their own tool messages.
		for (const rawPart of asArray(content.parts)) {
			const part = asRecord(rawPart)
			if (part.functionResponse === undefined) continue
			const response = asRecord(part.functionResponse)
			messages.push({
				role: "tool",
				tool_call_id: asString(response.name),
				name: asString(response.name),
				content: JSON.stringify(response.response ?? {}),
			})
		}

		const { text, toolCalls } = fromGeminiParts(content.parts)
		if (text === "" && toolCalls.length === 0) continue
		const message: Record<string, unknown> = { role, content: text === "" ? null : text }
		if (toolCalls.length > 0) message.tool_calls = toolCalls
		messages.push(message)
	}

	const generation = asRecord(input.generationConfig)
	const out: Record<string, unknown> = { model, messages }
	if (generation.temperature !== undefined) out.temperature = asNumber(generation.temperature)
	if (generation.topP !== undefined) out.top_p = asNumber(generation.topP)
	if (generation.maxOutputTokens !== undefined) {
		out.max_tokens = asNumber(generation.maxOutputTokens)
	}
	if (generation.stopSequences !== undefined) out.stop = asArray(generation.stopSequences)

	const declarations = asArray(input.tools).flatMap((tool) =>
		asArray(asRecord(tool).functionDeclarations),
	)
	if (declarations.length > 0) {
		out.tools = declarations.map((rawFn) => {
			const fn = asRecord(rawFn)
			return {
				type: "function",
				function: {
					name: asString(fn.name),
					description: asString(fn.description),
					parameters: isPlainObject(fn.parameters) ? fn.parameters : { type: "object" },
				},
			}
		})
	}

	return out
}

/** OpenAI chat completion -> Gemini generateContent response. */
export function openaiToGeminiResponse(body: unknown, requestedModel?: string): Record<string, unknown> {
	const input = sanitizeParsed(asRecord(body))
	const usage = asRecord(input.usage)
	const reasoning = asNumber(asRecord(usage.completion_tokens_details).reasoning_tokens)
	const completion = asNumber(usage.completion_tokens)

	const candidates = asArray(input.choices).map((rawChoice, index) => {
		const choice = asRecord(rawChoice)
		const message = asRecord(choice.message)
		const parts: Array<Record<string, unknown>> = []
		const text = asString(message.content)
		if (text !== "") parts.push({ text })
		for (const rawCall of asArray(message.tool_calls)) {
			const fn = asRecord(asRecord(rawCall).function)
			parts.push({
				functionCall: { name: asString(fn.name), args: parseArguments(fn.arguments) },
			})
		}
		return {
			content: { role: "model", parts },
			finishReason: finishReasonToGemini(choice.finish_reason),
			index: asNumber(choice.index) || index,
			safetyRatings: [],
		}
	})

	return {
		candidates,
		modelVersion: requestedModel || asString(input.model),
		usageMetadata: {
			promptTokenCount: asNumber(usage.prompt_tokens),
			// Gemini keeps reasoning outside the candidate count.
			candidatesTokenCount: Math.max(0, completion - reasoning),
			thoughtsTokenCount: reasoning,
			totalTokenCount: asNumber(usage.total_tokens),
			cachedContentTokenCount: asNumber(asRecord(usage.prompt_tokens_details).cached_tokens),
		},
	}
}

export type GeminiStreamTranslator = {
	handle: (event: SseEvent) => Array<Record<string, unknown>>
	usage: () => Record<string, unknown>
	done: () => boolean
}

/**
 * Gemini event stream -> OpenAI chunk stream.
 *
 * Every Gemini frame is a whole response object carrying the newest fragment,
 * and usageMetadata is repeated cumulatively, so the last one seen wins
 * rather than being summed.
 */
export function createGeminiStreamTranslator(options: {
	model: string
	id?: string
}): GeminiStreamTranslator {
	const id = options.id ?? `chatcmpl-${randomHex(12)}`
	const created = nowSeconds()
	let sentRole = false
	let toolCount = 0
	let finished = false
	let usageMetadata: Record<string, unknown> = {}

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
			if (Object.keys(payload).length === 0) return []

			if (payload.usageMetadata !== undefined) {
				usageMetadata = asRecord(payload.usageMetadata)
			}

			const out: Array<Record<string, unknown>> = []
			if (!sentRole) {
				sentRole = true
				out.push(chunk({ role: "assistant", content: "" }))
			}

			const candidate = asRecord(asArray(payload.candidates)[0])
			const { text, reasoning, toolCalls } = fromGeminiParts(asRecord(candidate.content).parts)

			if (reasoning !== "") out.push(chunk({ reasoning_content: reasoning }))
			if (text !== "") out.push(chunk({ content: text }))
			for (const call of toolCalls) {
				// Gemini emits a complete call in one frame rather than streaming
				// the arguments, so the whole thing goes out at once.
				out.push(chunk({ tool_calls: [{ ...call, index: toolCount++ }] }))
			}

			const reason = finishReasonFromGemini(candidate.finishReason, toolCalls.length > 0)
			if (reason) {
				finished = true
				out.push(chunk({}, reason))
			}
			return out
		},

		usage(): Record<string, unknown> {
			return usageFromGemini(usageMetadata)
		},

		done(): boolean {
			return finished
		},
	}
}
