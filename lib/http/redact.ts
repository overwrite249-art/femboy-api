/**
 * Secret redaction for logs, error bodies and telemetry.
 *
 * Closes GW-005 (upstream key echoed in an error body) and GW-023 (prompt
 * content written to logs). Every pattern is linear-time with bounded
 * quantifiers so the redactor itself cannot be used for ReDoS (GW-021); input
 * is additionally truncated before matching.
 */

import { hmacSha256Hex } from "../util/crypto.ts"
import { config } from "../config/env.ts"

const MAX_REDACT_INPUT = 128 * 1024

export const REDACTION = "[redacted]"

/**
 * Ordered list of secret shapes. Each pattern is anchored on a fixed literal
 * prefix and uses a bounded character class, never a nested quantifier.
 */
const PATTERNS: Array<{ re: RegExp; replace: string }> = [
	// Our own keys and the major provider formats.
	{ re: /sk-ant-[A-Za-z0-9_-]{6,200}/g, replace: REDACTION },
	{ re: /sk-proj-[A-Za-z0-9_-]{6,200}/g, replace: REDACTION },
	{ re: /sk-[A-Za-z0-9_-]{12,200}/g, replace: REDACTION },
	{ re: /AIza[A-Za-z0-9_-]{20,80}/g, replace: REDACTION },
	{ re: /ya29\.[A-Za-z0-9._-]{10,400}/g, replace: REDACTION },
	{ re: /AKIA[0-9A-Z]{12,20}/g, replace: REDACTION },
	{ re: /ASIA[0-9A-Z]{12,20}/g, replace: REDACTION },
	{ re: /gh[pousr]_[A-Za-z0-9]{20,255}/g, replace: REDACTION },
	{ re: /xox[baprs]-[A-Za-z0-9-]{10,255}/g, replace: REDACTION },
	{ re: /eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{5,4000}/g, replace: REDACTION },
	// Header and query shapes.
	{ re: /(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]{8,400}/gi, replace: `$1${REDACTION}` },
	{ re: /(x-api-key\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,400}/gi, replace: `$1${REDACTION}` },
	{ re: /(x-goog-api-key\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,400}/gi, replace: `$1${REDACTION}` },
	{ re: /(mj-api-secret\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,400}/gi, replace: `$1${REDACTION}` },
	{ re: /([?&](?:key|api_key|access_token|token)=)[A-Za-z0-9._~+/=-]{8,400}/gi, replace: `$1${REDACTION}` },
	// JSON shapes.
	{ re: /("(?:api_?key|apiKey|access_?token|secret|password|authorization)"\s*:\s*")[^"]{4,400}"/gi, replace: `$1${REDACTION}"` },
]

/** Redacts every known secret shape from a string. Safe on huge inputs. */
export function redact(input: string): string {
	if (!input) return input
	let text = input.length > MAX_REDACT_INPUT ? `${input.slice(0, MAX_REDACT_INPUT)}...[truncated]` : input
	for (const { re, replace } of PATTERNS) {
		re.lastIndex = 0
		text = text.replace(re, replace)
	}
	return text
}

/**
 * Removes a specific known secret (e.g. the exact upstream key used for this
 * request) even when it does not match a generic pattern. Always call this in
 * addition to `redact()` on upstream error bodies.
 */
export function redactKnown(input: string, secrets: Array<string | undefined | null>): string {
	let text = input
	for (const secret of secrets) {
		if (!secret || secret.length < 6) continue
		let index = text.indexOf(secret)
		while (index !== -1) {
			text = text.slice(0, index) + REDACTION + text.slice(index + secret.length)
			index = text.indexOf(secret, index + REDACTION.length)
		}
	}
	return text
}

/** Full sanitisation used before anything reaches a log sink or a client. */
export function sanitizeOutbound(input: string, knownSecrets: Array<string | undefined | null> = []): string {
	return redact(redactKnown(input, knownSecrets))
}

/** Recursively redacts string leaves of a JSON-ish structure. */
export function redactDeep<T>(value: T, depth = 0): T {
	if (depth > 12) return value
	if (typeof value === "string") return redact(value) as unknown as T
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (SENSITIVE_KEYS.has(k.toLowerCase())) {
				out[k] = REDACTION
				continue
			}
			out[k] = redactDeep(v, depth + 1)
		}
		return out as unknown as T
	}
	return value
}

const SENSITIVE_KEYS = new Set([
	"authorization",
	"api_key",
	"apikey",
	"x-api-key",
	"x-goog-api-key",
	"mj-api-secret",
	"key",
	"secret",
	"password",
	"session",
	"cookie",
	"set-cookie",
	"access_token",
	"refresh_token",
	"client_secret",
	"key_digest",
	"cipher",
	"auth_tag",
])

/** Header allowlist for structured logs. Values of unlisted headers are dropped. */
const LOGGABLE_HEADERS = new Set([
	"content-type",
	"content-length",
	"user-agent",
	"accept",
	"accept-encoding",
	"anthropic-version",
	"anthropic-beta",
	"openai-beta",
	"x-request-id",
])

export function loggableHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {}
	headers.forEach((value, key) => {
		const lower = key.toLowerCase()
		if (!LOGGABLE_HEADERS.has(lower)) return
		out[lower] = redact(value).slice(0, 256)
	})
	return out
}

/**
 * Non-reversible client IP identifier for storage (GW-024).
 * Never store or log the raw address.
 */
export async function hashIp(ip: string): Promise<string> {
	if (!ip) return ""
	const secret = config.ipHashSecret || "fbapi-dev-ip-salt"
	const digest = await hmacSha256Hex(secret, `ip:${ip}`)
	return digest.slice(0, 32)
}

/** Coarse display form for operators: 1.2.3.x / 2001:db8::/32. */
export function coarsenIp(ip: string): string {
	if (!ip) return ""
	if (ip.includes(":")) {
		const parts = ip.split(":")
		return `${parts.slice(0, 2).join(":")}::/32`
	}
	const octets = ip.split(".")
	if (octets.length !== 4) return ""
	return `${octets[0]}.${octets[1]}.${octets[2]}.x`
}

/**
 * Prompt content must never be logged. This returns only shape metadata.
 * (GW-023)
 */
export function promptShape(value: unknown): Record<string, number | string> {
	if (typeof value === "string") return { kind: "string", chars: value.length }
	if (Array.isArray(value)) return { kind: "array", items: value.length }
	if (value && typeof value === "object") {
		return { kind: "object", keys: Object.keys(value as object).length }
	}
	return { kind: typeof value, chars: 0 }
}
