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
 * `JSON.parse` with a reviver that drops dangerous keys outright.
 *
 * Using a reviver (rather than a post-walk) matters: by the time a post-walk
 * runs, `Object.prototype` has already been mutated by the parse itself in
 * engines that honour `__proto__` in object literals.
 */
export function safeJsonParse<T = unknown>(text: string, options: JsonParseOptions = {}): T {
	const maxBytes = options.maxBytes ?? config.maxRequestBodyBytes
	if (text.length > maxBytes) {
		throw new JsonLimitError("bytes", `payload exceeds ${maxBytes} bytes`)
	}
	const parsed = JSON.parse(text, function reviver(key, value) {
		if (FORBIDDEN_KEYS.has(key)) return undefined
		return value
	}) as T
	assertJsonLimits(parsed, options)
	return parsed
}

/** Strips forbidden keys from an already-parsed value (defence in depth). */
export function sanitizeParsed<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeParsed(item)) as unknown as T
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			if (FORBIDDEN_KEYS.has(key)) continue
			out[key] = sanitizeParsed(val)
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
		if (Array.isArray(current)) {
			for (const item of current) stack.push({ value: item, depth: entry.depth + 1 })
		} else if (current && typeof current === "object") {
			for (const item of Object.values(current as Record<string, unknown>)) {
				stack.push({ value: item, depth: entry.depth + 1 })
			}
		}
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
): Promise<string> {
	if (!body) return ""
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
	return new TextDecoder().decode(merged)
}
