/**
 * Response construction.
 *
 * Every response the gateway emits goes through here so that security headers,
 * CORS and the per-dialect error envelope are applied uniformly. Route
 * handlers never call `new Response()` directly for errors.
 */

import { GatewayError } from "./errors.ts"
import { sanitizeHeaderValue } from "./headers.ts"
import { redact } from "./redact.ts"

/** The client-facing API dialect a response must speak. */
export type Dialect = "openai" | "anthropic" | "gemini" | "midjourney" | "raw"

const SECURITY_HEADERS: Record<string, string> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"cross-origin-opener-policy": "same-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
}

export type ResponseInit2 = {
	status?: number
	headers?: Record<string, string>
	requestId?: string
	origin?: string | null
}

function baseHeaders(init: ResponseInit2 = {}): Headers {
	const headers = new Headers()
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
	for (const [name, value] of Object.entries(init.headers ?? {})) {
		headers.set(name.toLowerCase(), sanitizeHeaderValue(value))
	}
	if (init.requestId) headers.set("x-fbapi-request-id", sanitizeHeaderValue(init.requestId))
	applyCors(headers, init.origin ?? null)
	return headers
}

/**
 * The relay is a public API surface consumed by SDKs from arbitrary origins,
 * so `*` is correct here - but only because the relay authenticates with a
 * bearer token and never with cookies. Credentialed console routes use
 * `corsForConsole` instead.
 */
export function applyCors(headers: Headers, origin: string | null): void {
	headers.set("access-control-allow-origin", "*")
	headers.set(
		"access-control-allow-headers",
		"authorization, content-type, x-api-key, x-goog-api-key, anthropic-version, anthropic-beta, openai-beta, mj-api-secret, accept",
	)
	headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
	headers.set("access-control-max-age", "86400")
	if (origin) headers.append("vary", "origin")
}

export function jsonResponse(body: unknown, init: ResponseInit2 = {}): Response {
	const headers = baseHeaders(init)
	headers.set("content-type", "application/json; charset=utf-8")
	headers.set("cache-control", "no-store")
	return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

export function textResponse(body: string, init: ResponseInit2 = {}): Response {
	const headers = baseHeaders(init)
	if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8")
	return new Response(body, { status: init.status ?? 200, headers })
}

export function noContent(init: ResponseInit2 = {}): Response {
	return new Response(null, { status: init.status ?? 204, headers: baseHeaders(init) })
}

export function preflight(origin: string | null): Response {
	return new Response(null, { status: 204, headers: baseHeaders({ origin }) })
}

/** Streaming response with the framing headers SSE clients require. */
export function streamResponse(
	stream: ReadableStream<Uint8Array>,
	init: ResponseInit2 & { contentType?: string } = {},
): Response {
	const headers = baseHeaders(init)
	headers.set("content-type", init.contentType ?? "text/event-stream; charset=utf-8")
	headers.set("cache-control", "no-cache, no-transform")
	headers.set("connection", "keep-alive")
	// Defeats proxy buffering that would otherwise defer every chunk.
	headers.set("x-accel-buffering", "no")
	return new Response(stream, { status: init.status ?? 200, headers })
}

// ---------------------------------------------------------------------------
// error envelopes
// ---------------------------------------------------------------------------

export function errorBody(error: GatewayError, dialect: Dialect): unknown {
	const message = redact(error.message)
	switch (dialect) {
		case "anthropic":
			return {
				type: "error",
				error: { type: anthropicErrorType(error), message },
			}
		case "gemini":
			return {
				error: {
					code: error.status,
					message,
					status: geminiStatus(error.status),
					details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: error.code }],
				},
			}
		case "midjourney":
			return { code: error.status, description: message, result: "", properties: {} }
		case "raw":
			return { error: message, code: error.code }
		default:
			return {
				error: {
					message,
					type: error.kind,
					param: error.param,
					code: error.code,
				},
			}
	}
}

function anthropicErrorType(error: GatewayError): string {
	switch (error.status) {
		case 400:
			return "invalid_request_error"
		case 401:
			return "authentication_error"
		case 403:
			return "permission_error"
		case 404:
			return "not_found_error"
		case 413:
			return "request_too_large"
		case 429:
			return "rate_limit_error"
		case 529:
			return "overloaded_error"
		default:
			return error.status >= 500 ? "api_error" : "invalid_request_error"
	}
}

function geminiStatus(status: number): string {
	const table: Record<number, string> = {
		400: "INVALID_ARGUMENT",
		401: "UNAUTHENTICATED",
		402: "FAILED_PRECONDITION",
		403: "PERMISSION_DENIED",
		404: "NOT_FOUND",
		409: "ABORTED",
		413: "OUT_OF_RANGE",
		429: "RESOURCE_EXHAUSTED",
		499: "CANCELLED",
		500: "INTERNAL",
		501: "UNIMPLEMENTED",
		502: "INTERNAL",
		503: "UNAVAILABLE",
		504: "DEADLINE_EXCEEDED",
	}
	return table[status] ?? "UNKNOWN"
}

export function errorResponse(
	error: unknown,
	dialect: Dialect = "openai",
	init: ResponseInit2 = {},
): Response {
	const gatewayError = GatewayError.from(error)
	const headers: Record<string, string> = { ...(init.headers ?? {}) }
	const retryAfter = (gatewayError.details as { retryAfterSec?: number } | undefined)?.retryAfterSec
	if (retryAfter !== undefined) headers["retry-after"] = String(Math.ceil(retryAfter))
	headers["x-fbapi-error-code"] = gatewayError.code
	// 499 is nginx-only; a client that already vanished cannot read it anyway.
	const status = gatewayError.status === 499 ? 408 : gatewayError.status
	return jsonResponse(errorBody(gatewayError, dialect), { ...init, status, headers })
}

/**
 * Emits an error INSIDE an already-open SSE stream. Once headers are sent the
 * status line cannot change, so the failure has to travel as an event.
 */
export function errorSseChunk(error: unknown, dialect: Dialect): string {
	const gatewayError = GatewayError.from(error)
	const body = errorBody(gatewayError, dialect)
	if (dialect === "anthropic") {
		return `event: error\ndata: ${JSON.stringify(body)}\n\n`
	}
	return `data: ${JSON.stringify(body)}\n\n`
}

/** Infers the dialect a path should answer in. */
export function dialectForPath(pathname: string): Dialect {
	if (pathname.includes("/v1/messages")) return "anthropic"
	if (pathname.includes("/v1beta/") || pathname.includes("/v1/models/")) return "gemini"
	if (pathname.includes("/mj/") || pathname.includes("/mj-")) return "midjourney"
	return "openai"
}
