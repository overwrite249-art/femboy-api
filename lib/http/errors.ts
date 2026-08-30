/**
 * Error taxonomy.
 *
 * Every failure that leaves the gateway is a `GatewayError`. It carries a
 * stable machine code, an HTTP status, whether the condition is retryable
 * against a different upstream channel, and a redaction-safe message.
 *
 * Upstream error bodies are NEVER passed through verbatim: they can contain
 * the upstream API key, internal hostnames, or organisation identifiers
 * (GW-005). `fromUpstream()` extracts only the message text and re-renders it
 * through the redactor.
 */

import { redact } from "./redact.ts"

export const ErrorCode = {
	// auth
	MISSING_CREDENTIALS: "missing_credentials",
	INVALID_API_KEY: "invalid_api_key",
	KEY_DISABLED: "key_disabled",
	KEY_EXPIRED: "key_expired",
	KEY_EXHAUSTED: "key_exhausted",
	IP_NOT_ALLOWED: "ip_not_allowed",
	MODEL_NOT_ALLOWED: "model_not_allowed",
	INSUFFICIENT_PERMISSIONS: "insufficient_permissions",
	USER_DISABLED: "user_disabled",

	// quota
	INSUFFICIENT_QUOTA: "insufficient_quota",
	QUOTA_RESERVATION_FAILED: "quota_reservation_failed",

	// limits
	RATE_LIMIT_EXCEEDED: "rate_limit_exceeded",
	TPM_LIMIT_EXCEEDED: "tpm_limit_exceeded",
	CONCURRENCY_LIMIT: "concurrency_limit",
	PAYLOAD_TOO_LARGE: "payload_too_large",

	// request shape
	INVALID_REQUEST: "invalid_request",
	MISSING_MODEL: "missing_model",
	UNSUPPORTED_ENDPOINT: "unsupported_endpoint",
	UNSUPPORTED_PARAMETER: "unsupported_parameter",
	MALFORMED_JSON: "malformed_json",

	// routing
	NO_CHANNEL_AVAILABLE: "no_channel_available",
	ALL_CHANNELS_FAILED: "all_channels_failed",
	CHANNEL_DISABLED: "channel_disabled",

	// upstream
	UPSTREAM_ERROR: "upstream_error",
	UPSTREAM_TIMEOUT: "upstream_timeout",
	UPSTREAM_UNREACHABLE: "upstream_unreachable",
	MALFORMED_UPSTREAM_BODY: "malformed_upstream_body",
	STREAM_IDLE_TIMEOUT: "stream_idle_timeout",

	// safety
	SSRF_BLOCKED: "ssrf_blocked",
	CONTENT_FILTERED: "content_filtered",

	// platform
	INTERNAL_ERROR: "internal_error",
	NOT_IMPLEMENTED: "not_implemented",
	NOT_FOUND: "not_found",
	SERVICE_UNAVAILABLE: "service_unavailable",
	CONFIGURATION_ERROR: "configuration_error",
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

/** OpenAI-style error "type" buckets. */
export type ErrorKind =
	| "invalid_request_error"
	| "authentication_error"
	| "permission_error"
	| "not_found_error"
	| "rate_limit_error"
	| "insufficient_quota"
	| "api_error"
	| "overloaded_error"

export type GatewayErrorInit = {
	code: ErrorCodeValue
	status: number
	message: string
	kind?: ErrorKind
	param?: string | null
	/** true when another channel could plausibly succeed */
	retryable?: boolean
	/** the status the upstream returned, when the error came from one */
	upstreamStatus?: number
	channelId?: string
	details?: Record<string, unknown>
	cause?: unknown
}

export class GatewayError extends Error {
	readonly code: ErrorCodeValue
	readonly status: number
	readonly kind: ErrorKind
	readonly param: string | null
	readonly retryable: boolean
	readonly upstreamStatus?: number
	readonly channelId?: string
	readonly details?: Record<string, unknown>

	constructor(init: GatewayErrorInit) {
		super(redact(init.message))
		this.name = "GatewayError"
		this.code = init.code
		this.status = init.status
		this.kind = init.kind ?? kindForStatus(init.status)
		this.param = init.param ?? null
		this.retryable = init.retryable ?? false
		this.upstreamStatus = init.upstreamStatus
		this.channelId = init.channelId
		this.details = init.details
		if (init.cause !== undefined) this.cause = init.cause
	}

	static is(value: unknown): value is GatewayError {
		return value instanceof GatewayError
	}

	/** Wraps anything thrown into a GatewayError without leaking stack details. */
	static from(value: unknown): GatewayError {
		if (GatewayError.is(value)) return value
		if (value instanceof DOMException && value.name === "TimeoutError") {
			return upstreamTimeout(value.message)
		}
		if (value instanceof DOMException && value.name === "AbortError") {
			return new GatewayError({
				code: ErrorCode.UPSTREAM_TIMEOUT,
				status: 499,
				message: "client closed the request",
				retryable: false,
			})
		}
		const message = value instanceof Error ? value.message : String(value)
		return new GatewayError({
			code: ErrorCode.INTERNAL_ERROR,
			status: 500,
			message,
			cause: value,
		})
	}
}

function kindForStatus(status: number): ErrorKind {
	if (status === 401) return "authentication_error"
	if (status === 403) return "permission_error"
	if (status === 404) return "not_found_error"
	if (status === 429) return "rate_limit_error"
	if (status === 402) return "insufficient_quota"
	if (status >= 500) return "api_error"
	return "invalid_request_error"
}

// ---------------------------------------------------------------------------
// constructors
// ---------------------------------------------------------------------------

export function invalidRequest(message: string, param?: string): GatewayError {
	return new GatewayError({
		code: ErrorCode.INVALID_REQUEST,
		status: 400,
		message,
		param,
	})
}

export function unauthorized(
	message = "invalid api key",
	code: ErrorCodeValue = ErrorCode.INVALID_API_KEY,
): GatewayError {
	return new GatewayError({ code, status: 401, message })
}

export function forbidden(
	message: string,
	code: ErrorCodeValue = ErrorCode.INSUFFICIENT_PERMISSIONS,
): GatewayError {
	return new GatewayError({ code, status: 403, message })
}

export function notFound(message = "not found"): GatewayError {
	return new GatewayError({ code: ErrorCode.NOT_FOUND, status: 404, message })
}

export function insufficientQuota(message = "insufficient quota"): GatewayError {
	return new GatewayError({
		code: ErrorCode.INSUFFICIENT_QUOTA,
		status: 402,
		message,
		kind: "insufficient_quota",
	})
}

export function rateLimited(message: string, retryAfterSec?: number): GatewayError {
	return new GatewayError({
		code: ErrorCode.RATE_LIMIT_EXCEEDED,
		status: 429,
		message,
		details: retryAfterSec === undefined ? undefined : { retryAfterSec },
	})
}

export function payloadTooLarge(message: string): GatewayError {
	return new GatewayError({ code: ErrorCode.PAYLOAD_TOO_LARGE, status: 413, message })
}

export function notImplemented(message: string): GatewayError {
	return new GatewayError({ code: ErrorCode.NOT_IMPLEMENTED, status: 501, message })
}

export function noChannelAvailable(model: string, group: string): GatewayError {
	return new GatewayError({
		code: ErrorCode.NO_CHANNEL_AVAILABLE,
		status: 503,
		message: `no channel is able to serve model "${model}" for group "${group}"`,
		kind: "overloaded_error",
	})
}

export function upstreamTimeout(message = "upstream timed out"): GatewayError {
	return new GatewayError({
		code: ErrorCode.UPSTREAM_TIMEOUT,
		status: 504,
		message,
		retryable: false,
	})
}

export function malformedUpstreamBody(message = "upstream returned an unparseable body"): GatewayError {
	return new GatewayError({
		code: ErrorCode.MALFORMED_UPSTREAM_BODY,
		status: 502,
		message,
		retryable: false,
	})
}

export function ssrfBlocked(reason: string): GatewayError {
	return new GatewayError({
		code: ErrorCode.SSRF_BLOCKED,
		status: 403,
		message: `upstream address rejected: ${reason}`,
	})
}

export function internalError(message = "internal error"): GatewayError {
	return new GatewayError({ code: ErrorCode.INTERNAL_ERROR, status: 500, message })
}

export function configurationError(message: string): GatewayError {
	return new GatewayError({ code: ErrorCode.CONFIGURATION_ERROR, status: 500, message })
}

/**
 * Builds an error from an upstream HTTP failure.
 *
 * `bodyText` is parsed best-effort for a human message; everything else is
 * discarded so upstream metadata cannot leak downstream.
 */
export function fromUpstream(
	status: number,
	bodyText: string,
	channelId?: string,
): GatewayError {
	let message = ""
	const trimmed = bodyText.slice(0, 8_192)
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>
		const err = parsed.error
		if (typeof err === "string") message = err
		else if (err && typeof err === "object") {
			const rec = err as Record<string, unknown>
			if (typeof rec.message === "string") message = rec.message
		}
		if (!message && typeof parsed.message === "string") message = parsed.message
		if (!message && Array.isArray(parsed)) {
			const first = parsed[0] as Record<string, unknown> | undefined
			const nested = first?.error as Record<string, unknown> | undefined
			if (nested && typeof nested.message === "string") message = nested.message
		}
	} catch {
		message = ""
	}
	if (!message) message = `upstream returned HTTP ${status}`
	return new GatewayError({
		code: ErrorCode.UPSTREAM_ERROR,
		status: normalizeUpstreamStatus(status),
		message: message.slice(0, 1_000),
		retryable: isRetryableStatus(status),
		upstreamStatus: status,
		channelId,
	})
}

/**
 * Statuses the gateway will retry on another channel.
 *
 * Mirrors the blueprint retry matrix: everything except 2xx, 400, 408, 504,
 * 524 and malformed bodies is considered a channel-level fault.
 */
export function isRetryableStatus(status: number): boolean {
	if (status >= 200 && status < 300) return false
	if (status === 400 || status === 408 || status === 504 || status === 524) return false
	if (status >= 100 && status < 200) return true
	if (status >= 300 && status < 400) return true
	if (status >= 401 && status <= 407) return true
	if (status >= 409 && status < 500) return true
	if (status >= 500 && status <= 503) return true
	if (status >= 505 && status <= 523) return true
	if (status >= 525 && status <= 599) return true
	return false
}

/** Never surface a bare upstream 401/403 as our own auth failure. */
function normalizeUpstreamStatus(status: number): number {
	if (status === 401 || status === 403) return 502
	if (status < 400) return 502
	if (status > 599) return 502
	return status
}
