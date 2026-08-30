/**
 * Header hygiene for both directions of the proxy.
 *
 * Closes:
 *  - GW-011 response splitting / header injection (CR, LF and NUL are rejected)
 *  - GW-006 X-Forwarded-For spoofing (the client-controlled prefix is ignored)
 *  - GW-018 admin credentials reaching an upstream provider
 *  - GW-005 upstream credentials reaching the client
 */

import { config } from "../config/env.ts"

/**
 * Headers that describe a single transport connection and must never be
 * forwarded across a proxy hop (RFC 9110 s7.6.1).
 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
])

/**
 * Client headers that must never be relayed upstream: our own credentials,
 * platform routing metadata, and anything that would let a caller impersonate
 * an infrastructure component.
 */
const NEVER_FORWARD_UPSTREAM = new Set([
	...HOP_BY_HOP,
	"host",
	"content-length",
	"authorization",
	"cookie",
	"x-api-key",
	"x-goog-api-key",
	"mj-api-secret",
	"api-key",
	"x-admin-token",
	"x-cron-secret",
	"x-vercel-id",
	"x-vercel-signature",
	"x-vercel-deployment-url",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-real-ip",
	"forwarded",
	"cf-connecting-ip",
	"true-client-ip",
	"x-fbapi-user",
	"x-fbapi-token",
	"x-fbapi-channel",
])

/**
 * Upstream headers that must never reach the client: provider account
 * metadata, credential echoes and transport framing we re-generate ourselves.
 */
const NEVER_FORWARD_DOWNSTREAM = new Set([
	...HOP_BY_HOP,
	"content-encoding",
	"content-length",
	"set-cookie",
	"authorization",
	"x-api-key",
	"openai-organization",
	"openai-project",
	"x-organization",
	"x-request-id",
	"cf-ray",
	"cf-cache-status",
	"server",
	"via",
	"x-envoy-upstream-service-time",
	"x-amzn-requestid",
	"x-amz-request-id",
	"x-goog-quota-user",
	"x-served-by",
])

/** Upstream headers worth preserving because clients act on them. */
const PASSTHROUGH_DOWNSTREAM = new Set([
	"content-type",
	"retry-after",
	"x-ratelimit-limit-requests",
	"x-ratelimit-limit-tokens",
	"x-ratelimit-remaining-requests",
	"x-ratelimit-remaining-tokens",
	"x-ratelimit-reset-requests",
	"x-ratelimit-reset-tokens",
	"anthropic-ratelimit-requests-limit",
	"anthropic-ratelimit-requests-remaining",
	"anthropic-ratelimit-tokens-limit",
	"anthropic-ratelimit-tokens-remaining",
])

export class HeaderInjectionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "HeaderInjectionError"
	}
}

const CONTROL_CHARS = /[\r\n\0\x7f]|[\x00-\x08]|[\x0b\x0c]|[\x0e-\x1f]/

/** True when a value would allow header or response splitting. */
export function hasHeaderInjection(value: string): boolean {
	return CONTROL_CHARS.test(value)
}

/**
 * Rejects rather than sanitises: silently stripping CRLF hides an attack, and
 * every legitimate caller can express its intent without control characters.
 */
export function assertSafeHeaderValue(name: string, value: string): string {
	if (hasHeaderInjection(value)) {
		throw new HeaderInjectionError(`illegal control character in header "${name}"`)
	}
	if (value.length > 8_192) {
		throw new HeaderInjectionError(`header "${name}" exceeds 8192 bytes`)
	}
	return value
}

export function assertSafeHeaderName(name: string): string {
	if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
		throw new HeaderInjectionError(`illegal header name "${name.slice(0, 64)}"`)
	}
	return name.toLowerCase()
}

/** Strips control characters from a value destined for a header we emit. */
export function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n\0]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 8_192)
}

/**
 * Builds the header set for the upstream request.
 *
 * Starts from an empty Headers and copies an explicit allowlist-shaped subset:
 * the default is to drop, not to forward.
 */
export function buildUpstreamHeaders(options: {
	clientHeaders: Headers
	/** Provider auth headers; already resolved and decrypted. */
	authHeaders: Record<string, string>
	/** Static per-channel headers from the channel config. */
	channelHeaders?: Record<string, string>
	contentType?: string
	/** Client headers explicitly permitted to pass through, lower-cased. */
	forwardList?: string[]
}): Headers {
	const out = new Headers()
	const forward = new Set(options.forwardList ?? DEFAULT_FORWARD_LIST)

	options.clientHeaders.forEach((value, rawName) => {
		const name = rawName.toLowerCase()
		if (NEVER_FORWARD_UPSTREAM.has(name)) return
		if (!forward.has(name)) return
		if (hasHeaderInjection(value)) return
		out.set(name, value)
	})

	for (const [name, value] of Object.entries(options.channelHeaders ?? {})) {
		const lower = assertSafeHeaderName(name)
		if (NEVER_FORWARD_UPSTREAM.has(lower)) continue
		out.set(lower, assertSafeHeaderValue(lower, value))
	}

	// Auth last: a channel header must never be able to override credentials.
	for (const [name, value] of Object.entries(options.authHeaders)) {
		const lower = assertSafeHeaderName(name)
		out.set(lower, assertSafeHeaderValue(lower, value))
	}

	if (options.contentType) out.set("content-type", options.contentType)
	if (!out.has("accept")) out.set("accept", "application/json")
	out.set("user-agent", `${config.siteName.replace(/[^\x20-\x7e]/g, "")}/1.0`)
	return out
}

/** Client headers that carry meaning for providers and are safe to relay. */
export const DEFAULT_FORWARD_LIST = [
	"accept",
	"accept-language",
	"anthropic-beta",
	"anthropic-version",
	"openai-beta",
	"x-stainless-lang",
	"x-stainless-package-version",
	"x-stainless-os",
	"x-stainless-arch",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
]

/** Filters an upstream response's headers down to what the client may see. */
export function filterDownstreamHeaders(upstream: Headers): Headers {
	const out = new Headers()
	upstream.forEach((value, rawName) => {
		const name = rawName.toLowerCase()
		if (NEVER_FORWARD_DOWNSTREAM.has(name)) return
		if (!PASSTHROUGH_DOWNSTREAM.has(name)) return
		if (hasHeaderInjection(value)) return
		out.set(name, value)
	})
	return out
}

/**
 * Resolves the real client address.
 *
 * X-Forwarded-For is appended to by every hop, so the trustworthy entries are
 * at the END of the list. With `TRUSTED_PROXY_HOPS = n` the client address is
 * the n-th entry counted from the right. Anything the caller prepends is
 * ignored, which is what defeats spoofing (GW-006).
 */
export function getClientIp(headers: Headers, trustedHops = config.trustedProxyHops): string {
	const xff = headers.get("x-forwarded-for")
	if (xff) {
		const parts = xff
			.split(",")
			.map((p) => normalizeIp(p.trim()))
			.filter((p) => p.length > 0)
		if (parts.length > 0) {
			const index = Math.max(0, parts.length - Math.max(1, trustedHops))
			return parts[index]
		}
	}
	// Platform-provided single-value headers are set by the edge, not the client.
	const real = headers.get("x-real-ip") ?? headers.get("cf-connecting-ip")
	return real ? normalizeIp(real) : ""
}

export function normalizeIp(value: string): string {
	let ip = value.trim().toLowerCase()
	if (ip.startsWith("[")) {
		const close = ip.indexOf("]")
		if (close !== -1) ip = ip.slice(1, close)
	} else if ((ip.match(/:/g) ?? []).length === 1) {
		// host:port form for IPv4
		ip = ip.split(":")[0]
	}
	if (ip.startsWith("::ffff:")) ip = ip.slice(7)
	if (!/^[0-9a-f:.]+$/.test(ip)) return ""
	return ip
}

/** Extracts the bearer value from an Authorization header, if present. */
export function bearerFrom(headers: Headers): string {
	const raw = headers.get("authorization")
	if (!raw) return ""
	const match = /^bearer\s+(.+)$/i.exec(raw.trim())
	return match ? match[1].trim() : raw.trim()
}

export { HOP_BY_HOP, NEVER_FORWARD_UPSTREAM, NEVER_FORWARD_DOWNSTREAM, PASSTHROUGH_DOWNSTREAM }
