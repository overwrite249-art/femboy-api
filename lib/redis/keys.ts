/**
 * Redis key namespace.
 *
 * Every key the gateway touches is built here so that the blast radius of a
 * rename is one file and so that no user-controlled value is ever concatenated
 * into a key without being escaped first.
 */

/** Colons are the namespace separator, so they must not survive in a segment. */
export function seg(value: string): string {
	return String(value).replace(/[^A-Za-z0-9_.\-*]/g, "_").slice(0, 128)
}

export const K = {
	/** Cached token record, keyed by the public 8-char key prefix. */
	token: (prefix: string) => `tok:${seg(prefix)}`,
	/** Cached user record. */
	user: (userId: string) => `usr:${seg(userId)}`,
	/** Authoritative-ish hot quota counter for a user. */
	userQuota: (userId: string) => `q:usr:${seg(userId)}`,
	/** Per-token quota counter (only for tokens with their own budget). */
	tokenQuota: (tokenId: string) => `q:tok:${seg(tokenId)}`,
	/** In-flight quota reservation. */
	reservation: (reservationId: string) => `resv:${seg(reservationId)}`,

	/** Requests-per-minute token bucket. scope is user|token|ip|channel. */
	rpm: (scope: string, id: string) => `rl:rpm:${seg(scope)}:${seg(id)}`,
	/** Tokens-per-minute bucket. */
	tpm: (scope: string, id: string) => `rl:tpm:${seg(scope)}:${seg(id)}`,
	/** Successful-requests sliding window (abuse damper). */
	successWindow: (userId: string) => `rl:succ:${seg(userId)}`,
	/** Concurrency gate. */
	concurrency: (scope: string, id: string) => `rl:conc:${seg(scope)}:${seg(id)}`,

	/** Sorted channel candidates for a (group, model) pair. */
	ability: (group: string, model: string) => `ab:${seg(group)}:${seg(model)}`,
	/** Bumped on any ability write; embedded in ability cache entries. */
	abilityGeneration: () => "ab:generation",
	/** Cached channel record. */
	channel: (channelId: string) => `ch:${seg(channelId)}`,
	/** Circuit-breaker state for a channel. */
	channelHealth: (channelId: string) => `chhealth:${seg(channelId)}`,
	/** Round-robin cursor across a channel's key pool. */
	channelKeyIndex: (channelId: string) => `chkey:${seg(channelId)}:idx`,
	/** Sticky routing pin. */
	affinity: (rule: string, hash: string) => `aff:${seg(rule)}:${seg(hash)}`,

	/** Versioned pricing snapshot. */
	pricing: (version: number | string) => `pricing:v${seg(String(version))}`,
	/** Buffered usage rows awaiting a flush to Mongo. */
	usageBuffer: () => "usagebuf",
	/** Idempotency marker for a request id. */
	idempotency: (requestId: string) => `idem:${seg(requestId)}`,
	/** Durable stream of quota mutations pending reconciliation. */
	quotaJournal: () => "quota:journal",
	/** Distributed lock (cron singleflight). */
	lock: (name: string) => `lock:${seg(name)}`,
	/** OAuth CSRF state. */
	oauthState: (state: string) => `oauth:${seg(state)}`,
	/** Redemption brute-force counter. */
	redeemAttempts: (subject: string) => `redeem:att:${seg(subject)}`,
	/** Cached upstream DNS resolution decision for the SSRF guard. */
	ssrfVerdict: (host: string) => `ssrf:${seg(host)}`,
} as const

export type KeyBuilder = typeof K
