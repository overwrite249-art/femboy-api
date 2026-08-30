/**
 * Server-sent event framing.
 *
 * Both directions are handled here: parsing what an upstream sends, and
 * serialising what is sent to the client. The two carry different risks.
 *
 * Parsing is a memory problem. An upstream that opens a stream and never
 * sends a line terminator would otherwise grow the buffer until the function
 * dies (GW-007), so the unterminated buffer is capped.
 *
 * Serialising is an injection problem. Event frames are delimited by a blank
 * line, so any payload containing one - trivially arranged by asking a model
 * to repeat a string - would end the current frame and begin a new one that
 * the gateway never wrote (GW-011). Splitting payload newlines across data:
 * lines is what makes that impossible, and it is also what the specification
 * requires.
 */

import { config } from "../config/env.ts"
import { payloadTooLarge } from "../http/errors.ts"
import { safeJsonParse } from "../util/json.ts"

/** The sentinel OpenAI uses to close a stream. */
export const SSE_DONE = "[DONE]"

export type SseEvent = {
	/** The event: field, or null when the upstream omitted it. */
	event: string | null
	/** All data: lines joined with newlines, per the specification. */
	data: string
	id: string | null
	retry: number | null
	/** Set for keepalive comments; data is empty when this is present. */
	comment: string | null
}

export type SseParserOptions = {
	/** Overrides MAX_SSE_LINE_BYTES. */
	maxLineBytes?: number
}

/** Field values are single-line by definition; a newline would reframe. */
function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ")
}

function splitLines(value: string): string[] {
	return value.split(/\r\n|\n|\r/)
}

/**
 * Serialises an event.
 *
 * Every line of the payload gets its own data: prefix, so a payload that
 * contains a frame boundary is transmitted as literal text rather than
 * becoming a boundary.
 */
export function formatSse(event: Partial<SseEvent>): string {
	let out = ""
	if (event.comment != null) out += `: ${oneLine(event.comment)}\n`
	if (event.id) out += `id: ${oneLine(event.id)}\n`
	if (event.event) out += `event: ${oneLine(event.event)}\n`
	if (event.retry != null && Number.isFinite(event.retry)) {
		out += `retry: ${Math.max(0, Math.floor(event.retry))}\n`
	}
	if (event.data != null) {
		for (const line of splitLines(event.data)) out += `data: ${line}\n`
	}
	return `${out}\n`
}

/** Serialises a value as a single JSON data frame. */
export function sseJson(value: unknown, eventName?: string): string {
	return formatSse({ data: JSON.stringify(value) ?? "null", event: eventName ?? null })
}

/** The terminating frame of an OpenAI-dialect stream. */
export function sseDone(): string {
	return formatSse({ data: SSE_DONE })
}

/** A keepalive comment. Clients ignore it; proxies keep the socket open. */
export function ssePing(text = "ping"): string {
	return `: ${oneLine(text)}\n\n`
}

export type SseParser = {
	/** Feeds text and returns whatever events completed. */
	push: (chunk: string) => SseEvent[]
	/** Emits a trailing unterminated event, if any. */
	flush: () => SseEvent[]
}

/**
 * Incremental parser.
 *
 * Chunk boundaries are arbitrary - a field name can be split across two TCP
 * reads - so state is carried between calls.
 */
export function createSseParser(options: SseParserOptions = {}): SseParser {
	const maxLineBytes = options.maxLineBytes ?? config.maxSseLineBytes
	let buffer = ""
	let dataLines: string[] = []
	let eventName: string | null = null
	let lastId: string | null = null
	let retry: number | null = null
	let pending = false

	function dispatch(out: SseEvent[]): void {
		if (!pending) return
		out.push({
			event: eventName,
			data: dataLines.join("\n"),
			id: lastId,
			retry,
			comment: null,
		})
		// The last id persists across events by design; the rest do not.
		eventName = null
		dataLines = []
		retry = null
		pending = false
	}

	function handleLine(line: string, out: SseEvent[]): void {
		if (line === "") {
			dispatch(out)
			return
		}
		if (line.startsWith(":")) {
			out.push({
				event: null,
				data: "",
				id: null,
				retry: null,
				comment: line.slice(1).replace(/^ /, ""),
			})
			return
		}

		const colon = line.indexOf(":")
		const field = colon === -1 ? line : line.slice(0, colon)
		// Exactly one leading space after the colon is part of the delimiter.
		const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")

		switch (field) {
			case "data":
				dataLines.push(value)
				pending = true
				break
			case "event":
				eventName = value
				pending = true
				break
			case "id":
				// A NUL in the id is required to be ignored.
				if (!value.includes("\u0000")) lastId = value
				pending = true
				break
			case "retry": {
				const parsed = Number(value)
				if (Number.isInteger(parsed) && parsed >= 0) retry = parsed
				pending = true
				break
			}
			default:
				// Unknown fields are ignored, not an error.
				break
		}
	}

	return {
		push(chunk: string): SseEvent[] {
			const out: SseEvent[] = []
			buffer += chunk

			let index = buffer.search(/\r\n|\n|\r/)
			while (index !== -1) {
				const line = buffer.slice(0, index)
				const skip = buffer.startsWith("\r\n", index) ? 2 : 1
				buffer = buffer.slice(index + skip)
				handleLine(line, out)
				index = buffer.search(/\r\n|\n|\r/)
			}

			// Nothing has terminated the line yet. Bound what is held.
			if (buffer.length > maxLineBytes) {
				buffer = ""
				throw payloadTooLarge(`upstream sent an SSE line over ${maxLineBytes} bytes`)
			}
			return out
		},

		flush(): SseEvent[] {
			const out: SseEvent[] = []
			if (buffer.length > 0) {
				const line = buffer
				buffer = ""
				handleLine(line, out)
			}
			// The specification discards an unterminated final block. A gateway
			// cannot: dropping the last chunk silently truncates the answer, so
			// it is emitted and the caller decides.
			dispatch(out)
			return out
		},
	}
}

/**
 * Parses a data payload as JSON.
 *
 * Returns null for the [DONE] sentinel and for anything unparseable, so a
 * single malformed frame degrades one chunk rather than the whole stream.
 * Parsing goes through safeJsonParse because this data is attacker-influenced
 * and may be merged into gateway objects later (GW-017).
 */
export function parseSseData<T = unknown>(data: string): T | null {
	const trimmed = data.trim()
	if (trimmed === "" || trimmed === SSE_DONE) return null
	try {
		return safeJsonParse<T>(trimmed)
	} catch {
		return null
	}
}

/**
 * Decodes a byte stream into parsed events.
 *
 * The pull loops until it has something to hand over. A chunk that completes
 * no event is the normal case for SSE, and returning from pull without
 * enqueuing relies on the consumer calling pull again - which the streams
 * specification asks for but not every runtime does. Looping here removes the
 * dependency entirely.
 */
export function sseEventStream(
	source: ReadableStream<Uint8Array>,
	options: SseParserOptions = {},
): ReadableStream<SseEvent> {
	const reader = source.getReader()
	const decoder = new TextDecoder()
	const parser = createSseParser(options)

	return new ReadableStream<SseEvent>({
		async pull(controller) {
			try {
				for (;;) {
					const { done, value } = await reader.read()
					if (done) {
						for (const event of parser.flush()) controller.enqueue(event)
						controller.close()
						return
					}
					// stream: true so a multibyte character split across two reads
					// is held rather than replaced with U+FFFD.
					const events = parser.push(decoder.decode(value, { stream: true }))
					if (events.length > 0) {
						for (const event of events) controller.enqueue(event)
						return
					}
				}
			} catch (error) {
				reader.cancel().catch(() => undefined)
				controller.error(error)
			}
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
}

/** Encodes strings or events into bytes for the response body. */
export function encodeSseStream(
	source: ReadableStream<SseEvent | string>,
): ReadableStream<Uint8Array> {
	const reader = source.getReader()
	const encoder = new TextEncoder()

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				for (;;) {
					const { done, value } = await reader.read()
					if (done) {
						controller.close()
						return
					}
					const text = typeof value === "string" ? value : formatSse(value)
					if (text.length > 0) {
						controller.enqueue(encoder.encode(text))
						return
					}
				}
			} catch (error) {
				reader.cancel().catch(() => undefined)
				controller.error(error)
			}
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
}

/**
 * Line-delimited JSON, used by Gemini and several media providers.
 *
 * Same cap as the SSE parser, for the same reason.
 */
export function createNdjsonParser(options: SseParserOptions = {}): {
	push: (chunk: string) => string[]
	flush: () => string[]
} {
	const maxLineBytes = options.maxLineBytes ?? config.maxSseLineBytes
	let buffer = ""

	return {
		push(chunk: string): string[] {
			buffer += chunk
			const out: string[] = []
			let index = buffer.indexOf("\n")
			while (index !== -1) {
				const line = buffer.slice(0, index).trim()
				buffer = buffer.slice(index + 1)
				if (line !== "") out.push(line)
				index = buffer.indexOf("\n")
			}
			if (buffer.length > maxLineBytes) {
				buffer = ""
				throw payloadTooLarge(`upstream sent a line over ${maxLineBytes} bytes`)
			}
			return out
		},
		flush(): string[] {
			const line = buffer.trim()
			buffer = ""
			return line === "" ? [] : [line]
		},
	}
}
