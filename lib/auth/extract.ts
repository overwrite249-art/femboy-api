/**
 * Credential extraction across provider dialects.
 *
 * Every SDK we emulate sends the key somewhere different, and clients
 * routinely point an OpenAI SDK at an Anthropic model or vice versa. Accepting
 * all of these is what makes the gateway a drop-in replacement.
 *
 * Deliberately absent: cookies. A console session must never authenticate a
 * relay request (GW-018).
 */

export type CredentialSource =
	| "authorization"
	| "x-api-key"
	| "api-key"
	| "x-goog-api-key"
	| "mj-api-secret"
	| "websocket"
	| "query"
	| "none"

export type ExtractedCredential = {
	raw: string
	source: CredentialSource
}

const WS_KEY_PREFIX = "openai-insecure-api-key."
const MAX_CREDENTIAL_LENGTH = 512

function clean(value: string | null): string {
	if (!value) return ""
	const trimmed = value.trim()
	return trimmed.length > MAX_CREDENTIAL_LENGTH ? "" : trimmed
}

/** Strips a `Bearer ` prefix, case-insensitively, tolerating extra spaces. */
export function stripBearer(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length < 7) return trimmed
	if (trimmed.slice(0, 6).toLowerCase() !== "bearer") return trimmed
	const rest = trimmed.slice(6)
	if (rest.length === 0 || (rest[0] !== " " && rest[0] !== "\t")) return trimmed
	return rest.trim()
}

/**
 * Pulls the credential out of a request, in the order of decreasing
 * intentionality: an explicit Authorization header wins over a query string
 * that may have been logged by a proxy.
 */
export function extractCredential(req: Request): ExtractedCredential {
	const headers = req.headers

	const authorization = clean(headers.get("authorization"))
	if (authorization) return { raw: stripBearer(authorization), source: "authorization" }

	// Anthropic SDK.
	const anthropic = clean(headers.get("x-api-key"))
	if (anthropic) return { raw: stripBearer(anthropic), source: "x-api-key" }

	// Azure OpenAI SDK.
	const azure = clean(headers.get("api-key"))
	if (azure) return { raw: stripBearer(azure), source: "api-key" }

	// Google Generative AI SDK.
	const google = clean(headers.get("x-goog-api-key"))
	if (google) return { raw: stripBearer(google), source: "x-goog-api-key" }

	// Midjourney proxy clients.
	const midjourney = clean(headers.get("mj-api-secret"))
	if (midjourney) return { raw: stripBearer(midjourney), source: "mj-api-secret" }

	// Realtime WebSocket: the browser cannot set headers on an upgrade, so the
	// key rides in the subprotocol list.
	const protocols = clean(headers.get("sec-websocket-protocol"))
	if (protocols) {
		for (const entry of protocols.split(",")) {
			const candidate = entry.trim()
			if (candidate.startsWith(WS_KEY_PREFIX)) {
				return { raw: candidate.slice(WS_KEY_PREFIX.length).trim(), source: "websocket" }
			}
		}
	}

	// Gemini REST: ?key=...
	try {
		const url = new URL(req.url)
		const queryKey = clean(url.searchParams.get("key"))
		if (queryKey) return { raw: queryKey, source: "query" }
	} catch {
		// A malformed URL simply means there is no query credential.
	}

	return { raw: "", source: "none" }
}

/**
 * The subprotocol the server must echo on a realtime upgrade. Echoing the key
 * itself back would place a live credential in a response header.
 */
export function realtimeAcceptProtocol(headers: Headers): string | null {
	const protocols = clean(headers.get("sec-websocket-protocol"))
	if (!protocols) return null
	for (const entry of protocols.split(",")) {
		const candidate = entry.trim()
		if (candidate && !candidate.startsWith(WS_KEY_PREFIX)) return candidate
	}
	return null
}
