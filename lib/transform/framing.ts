/**
 * Writing a translated stream back out in the client's dialect.
 *
 * The translators in this directory all produce OpenAI-shaped chunks. That is
 * the right intermediate form, but it is not what an Anthropic or Gemini
 * client will parse, so the last step before the socket is to re-frame.
 *
 * The three dialects are shaped very differently:
 *
 * - OpenAI is a flat sequence of deltas ending in a [DONE] sentinel.
 * - Gemini is a sequence of whole response objects and has no sentinel.
 * - Anthropic is a tree. Content blocks are opened, appended to and closed,
 *   and the message itself is opened and closed around them. A client that
 *   never receives message_stop will wait until it times out, so the closing
 *   frames have to be emitted even when the upstream ends abruptly.
 *
 * Everything is serialised with formatSse, which splits payload newlines
 * across data: lines. Without that, a model asked to emit a blank line could
 * close the current frame and start one the gateway never wrote (GW-011).
 */

import { asArray, asNumber, asRecord, asString } from "../util/json.ts"
import { randomHex } from "../util/crypto.ts"
import { formatSse, sseDone } from "./sse.ts"
import { stopReasonFromOpenai } from "./anthropic.ts"
import { finishReasonToGemini } from "./gemini.ts"
import type { Dialect } from "./index.ts"

export type ClientFramer = {
	/** Frames to send before any content. */
	start: () => string
	/** Frames for one translated chunk. */
	chunk: (chunk: Record<string, unknown>) => string
	/** Closing frames, including usage where the dialect carries it. */
	finish: (usage?: Record<string, unknown>) => string
}

type Delta = {
	content: string
	reasoning: string
	toolCalls: Array<Record<string, unknown>>
	finishReason: string
}

function readDelta(chunk: Record<string, unknown>): Delta {
	const choice = asRecord(asArray(chunk.choices)[0])
	const delta = asRecord(choice.delta)
	return {
		content: asString(delta.content),
		reasoning: asString(delta.reasoning_content),
		toolCalls: asArray(delta.tool_calls).map((call) => asRecord(call)),
		finishReason: asString(choice.finish_reason),
	}
}

function openaiFramer(): ClientFramer {
	return {
		start: () => "",
		chunk: (chunk) => formatSse({ data: JSON.stringify(chunk) }),
		finish: () => sseDone(),
	}
}

/**
 * Gemini frames are whole response objects, and the stream simply stops.
 * Sending a [DONE] sentinel here would be a parse error for the client.
 */
function geminiFramer(): ClientFramer {
	let sawFinish = false

	return {
		start: () => "",

		chunk: (chunk) => {
			const { content, reasoning, toolCalls, finishReason } = readDelta(chunk)
			const parts: Array<Record<string, unknown>> = []
			if (reasoning !== "") parts.push({ text: reasoning, thought: true })
			if (content !== "") parts.push({ text: content })
			for (const call of toolCalls) {
				const fn = asRecord(call.function)
				const name = asString(fn.name)
				if (name === "") continue
				let args: unknown = {}
				try {
					args = JSON.parse(asString(fn.arguments) || "{}")
				} catch {
					args = {}
				}
				parts.push({ functionCall: { name, args } })
			}

			if (parts.length === 0 && finishReason === "") return ""

			const candidate: Record<string, unknown> = {
				content: { role: "model", parts },
				index: 0,
			}
			if (finishReason !== "") {
				candidate.finishReason = finishReasonToGemini(finishReason)
				sawFinish = true
			}
			return formatSse({ data: JSON.stringify({ candidates: [candidate] }) })
		},

		finish: (usage) => {
			const payload: Record<string, unknown> = {}
			if (!sawFinish) {
				payload.candidates = [
					{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 },
				]
			}
			if (usage) {
				const reasoning = asNumber(asRecord(usage.completion_tokens_details).reasoning_tokens)
				const completion = asNumber(usage.completion_tokens)
				payload.usageMetadata = {
					promptTokenCount: asNumber(usage.prompt_tokens),
					candidatesTokenCount: Math.max(0, completion - reasoning),
					thoughtsTokenCount: reasoning,
					totalTokenCount: asNumber(usage.total_tokens),
					cachedContentTokenCount: asNumber(
						asRecord(usage.prompt_tokens_details).cached_tokens,
					),
				}
			}
			return Object.keys(payload).length === 0 ? "" : formatSse({ data: JSON.stringify(payload) })
		},
	}
}

/**
 * Anthropic framing.
 *
 * Blocks are opened lazily, because the index a tool call gets depends on
 * whether any text arrived first, and closed in finish() so an upstream that
 * dies mid-block still produces a well-formed stream.
 */
function anthropicFramer(options: { model: string; id?: string }): ClientFramer {
	const messageId = options.id ?? `msg_${randomHex(12)}`
	const openToolBlocks = new Map<number, number>()
	let nextIndex = 0
	let textIndex: number | null = null
	let stopReason = "end_turn"
	let closed = false

	function frame(event: string, payload: Record<string, unknown>): string {
		return formatSse({ event, data: JSON.stringify({ type: event, ...payload }) })
	}

	return {
		start: () =>
			frame("message_start", {
				message: {
					id: messageId,
					type: "message",
					role: "assistant",
					model: options.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			}),

		chunk: (chunk) => {
			const { content, toolCalls, finishReason } = readDelta(chunk)
			let out = ""

			if (content !== "") {
				if (textIndex === null) {
					textIndex = nextIndex++
					out += frame("content_block_start", {
						index: textIndex,
						content_block: { type: "text", text: "" },
					})
				}
				out += frame("content_block_delta", {
					index: textIndex,
					delta: { type: "text_delta", text: content },
				})
			}

			for (const call of toolCalls) {
				const callIndex = asNumber(call.index)
				const fn = asRecord(call.function)
				let blockIndex = openToolBlocks.get(callIndex)

				if (blockIndex === undefined) {
					blockIndex = nextIndex++
					openToolBlocks.set(callIndex, blockIndex)
					out += frame("content_block_start", {
						index: blockIndex,
						content_block: {
							type: "tool_use",
							id: asString(call.id) || `toolu_${randomHex(8)}`,
							name: asString(fn.name),
							input: {},
						},
					})
				}

				const partial = asString(fn.arguments)
				if (partial !== "") {
					out += frame("content_block_delta", {
						index: blockIndex,
						delta: { type: "input_json_delta", partial_json: partial },
					})
				}
			}

			if (finishReason !== "") stopReason = stopReasonFromOpenai(finishReason)
			return out
		},

		finish: (usage) => {
			if (closed) return ""
			closed = true
			let out = ""

			// Close every block that was opened, newest first.
			const indexes = [...openToolBlocks.values()]
			if (textIndex !== null) indexes.push(textIndex)
			for (const index of indexes.sort((a, b) => b - a)) {
				out += frame("content_block_stop", { index })
			}

			out += frame("message_delta", {
				delta: { stop_reason: stopReason, stop_sequence: null },
				usage: { output_tokens: asNumber(usage?.completion_tokens) },
			})
			out += frame("message_stop", {})
			return out
		},
	}
}

/** Builds the framer for the dialect the client opened the stream in. */
export function createClientFramer(
	dialect: Dialect,
	options: { model: string; id?: string },
): ClientFramer {
	switch (dialect) {
		case "anthropic":
			return anthropicFramer(options)
		case "gemini":
			return geminiFramer()
		default:
			return openaiFramer()
	}
}
