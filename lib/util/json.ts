/**
 * Hardened JSON handling.
 *
 * Closes:
 *  - GW-017 prototype pollution through `__proto__` / `constructor.prototype`
 *  - GW-022 unbounded recursion in provider schemas (stack exhaustion)
 *  - GW-008 decompression / payload bombs (byte ceiling before parse)
 */

import { config } from "../config/env.ts"

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

export type JsonParseOptions = {
	maxBytes?: number
	maxDepth?: number
	maxNodes?: number
}

export class JsonLimitError extends Error {
	readonly limit: string
	constructor(limit: string, message: string) {
		super(message)
		this.name = "JsonLimitError"
		this.limit = limit
	}
}

/**
 * Parse without a recursive reviver, bound the tree, then remove dangerous
 * keys before returning it. JSON.parse creates own data properties; unlike
 * Object.assign, parsing "__proto__" does not mutate Object.prototype.
 */
export function safeJsonParse<T = unknown>(text: string, options: JsonParseOptions = {}): T {
	const maxBytes = options.maxBytes ?? config.maxRequestBodyBytes
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new JsonLimitError("bytes", `payload exceeds ${maxBytes} bytes`)
	}
	const parsed = JSON.parse(text) as T
	assertJsonLimits(parsed, options)
	return cloneSanitized(parsed)
}

/** Strips forbidden keys from an already-parsed value (defence in depth). */
export function sanitizeParsed<T>(value: T): T {
	assertJsonLimits(value)
	return cloneSanitized(value)
}

/** Only called after the iterative bounds check, so recursion is bounded. */
function cloneSanitized<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => cloneSanitized(item)) as unknown as T
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			if (FORBIDDEN_KEYS.has(key)) continue
			out[key] = cloneSanitized(val)
		}
		return out as unknown as T
	}
	return value
}

/** Iterative depth/size walk - never recurses, so it cannot blow the stack. */
export function assertJsonLimits(value: unknown, options: JsonParseOptions = {}): void {
	const maxDepth = options.maxDepth ?? config.maxJsonDepth
	const maxNodes = options.maxNodes ?? config.maxJsonNodes
	let nodes = 0
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
	while (stack.length > 0) {
		const entry = stack.pop()
		if (!entry) break
		nodes++
		if (nodes > maxNodes) {
			throw new JsonLimitError("nodes", `payload exceeds ${maxNodes} JSON nodes`)
		}
		if (entry.depth > maxDepth) {
			throw new JsonLimitError("depth", `payload nests deeper than ${maxDepth} levels`)
		}
		const current = entry.value
		const children = Array.isArray(current) ? current
			: current && typeof current === "object" ? Object.values(current) : []
		// Reject wide trees before allocating a work item for every child.
		if (nodes + stack.length + children.length > maxNodes) {
			throw new JsonLimitError("nodes", `payload exceeds ${maxNodes} JSON nodes`)
		}
		for (const item of children) stack.push({ value: item, depth: entry.depth + 1 })
	}
}

/** Computes the maximum nesting depth of a value (iteratively). */
export function jsonDepth(value: unknown): number {
	let max = 0
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
	while (stack.length > 0) {
		const entry = stack.pop()
		if (!entry) break
		if (entry.depth > max) max = entry.depth
		const current = entry.value
		if (Array.isArray(current)) {
			for (const item of current) stack.push({ value: item, depth: entry.depth + 1 })
		} else if (current && typeof current === "object") {
			for (const item of Object.values(current as Record<string, unknown>)) {
				stack.push({ value: item, depth: entry.depth + 1 })
			}
		}
	}
	return max
}

/** Deep clone that also strips forbidden keys. Structured-clone free. */
export function safeClone<T>(value: T): T {
	assertJsonLimits(value)
	return sanitizeParsed(JSON.parse(JSON.stringify(value)) as T)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> {
	return isPlainObject(value) ? value : {}
}

export function asArray<T = unknown>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : []
}

export function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback
}

export function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function asBool(value: unknown, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback
}

/**
 * Reads a request body with a hard byte ceiling, streaming so an oversized
 * payload is rejected before it is fully buffered (GW-008).
 */
export async function readLimitedText(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
	return new TextDecoder().decode(await readLimitedBytes(body, maxBytes, options))
}

/** Byte-faithful uploads share the same absolute deadline and cancellation. */
export async function readLimitedBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
	if (!body) return new Uint8Array(0)
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new JsonLimitError("timeout", "request body timed out")),
			Math.max(1, options.timeoutMs ?? config.requestBodyTimeoutMs))
		if (options.signal) {
			onAbort = () => reject(options.signal!.reason ?? new DOMException("aborted", "AbortError"))
			if (options.signal.aborted) onAbort()
			else options.signal.addEventListener("abort", onAbort, { once: true })
		}
	})
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), deadline])
			if (done) break
			if (!value) continue
			total += value.byteLength
			if (total > maxBytes) {
				throw new JsonLimitError("bytes", `payload exceeds ${maxBytes} bytes`)
			}
			chunks.push(value)
		}
	} catch (error) {
		// A hostile source's cancellation promise is not allowed to hold up an
		// already determined timeout or size error.
		void reader.cancel(error).catch(() => {})
		throw error
	} finally {
		clearTimeout(timer)
		if (onAbort) options.signal?.removeEventListener("abort", onAbort)
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
