/**
 * Request authentication.
 *
 * Invariants this module is responsible for:
 *
 *  1. Every outcome - malformed credential, unknown prefix, wrong secret,
 *     disabled account - costs the same observable time (GW-010, GW-026).
 *  2. A digest is computed on every path, so the hash is never a side channel
 *     for "this prefix exists".
 *  3. Nothing that can authenticate is ever cached or logged; the cache holds
 *     a digest, which is a verifier, not a credential.
 *  4. Console sessions cannot authenticate the relay (GW-018).
 */

import { config } from "../config/env.ts"
import { getClientIp } from "../http/headers.ts"
import { forbidden, unauthorized } from "../http/errors.ts"
import { ErrorCode } from "../http/errors.ts"
import { hashIp } from "../http/redact.ts"
import { K } from "../redis/keys.ts"
import { redisDel, redisGetJson, redisSetJson } from "../redis/client.ts"
import { tokens, users } from "../db/index.ts"
import { randomHex, timingSafeEqualHex } from "../util/crypto.ts"
import { nowMs, sleep } from "../util/time.ts"
import { matchesAnyCidr } from "./cidr.ts"
import { extractCredential } from "./extract.ts"
import { digestApiKey, modelMatches, parseApiKey } from "./keys.ts"
import type { CredentialSource } from "./extract.ts"
import type { KeyDirectives } from "./keys.ts"
import type { UserRole } from "../db/types.ts"

/** Cached negative results are short-lived: enough to blunt a scan, not enough to matter. */
const NEGATIVE_TTL_SEC = 5

/** Same length as a real SHA-256 digest, so the comparison does equal work. */
const DUMMY_DIGEST = "0".repeat(64)
const DUMMY_SECRET = "0".repeat(48)
const SESSION_TOKEN_PREFIX = "sess-"

/** The resolved caller. Contains no secret material. */
export type Identity = {
	tokenId: string
	tokenName: string
	keyPrefix: string
	keyLast4: string
	userId: string
	username: string
	role: UserRole
	/** Effective billing/routing group: the token's override, else the user's. */
	group: string
	unlimitedQuota: boolean
	tokenQuota: number
	userQuota: number
	allowedIps: string[]
	allowedModels: string[]
	rpmLimit: number
	tpmLimit: number
}

export type AuthContext = {
	identity: Identity
	directives: KeyDirectives
	source: CredentialSource
	clientIp: string
	ipHash: string
	/** Correlates the reservation, the settlement and the usage row. */
	requestId: string
	startedAt: number
}

type CacheHit = { hit: true; digest: string; identity: Identity }
type CacheMiss = { hit: false }
type CacheEntry = CacheHit | CacheMiss

/** Sleeps out the remainder of the latency floor. */
async function padAuthLatency(startedAt: number): Promise<void> {
	const floor = config.minAuthLatencyMs
	if (floor <= 0) return
	const elapsed = nowMs() - startedAt
	if (elapsed < floor) await sleep(floor - elapsed)
}

async function reject(startedAt: number, error: Error): Promise<never> {
	await padAuthLatency(startedAt)
	throw error
}

export function tokenCacheKey(prefix: string): string {
	return K.token(prefix)
}

/** Must be called by every write that changes a token, its owner, or their status. */
export async function invalidateTokenCache(prefix: string): Promise<void> {
	await redisDel(tokenCacheKey(prefix))
}

export async function invalidateTokenCaches(prefixes: string[]): Promise<void> {
	if (prefixes.length === 0) return
	await redisDel(...prefixes.map(tokenCacheKey))
}

/**
 * Resolves a key prefix to a cached identity, falling back to MongoDB.
 * Only enabled, non-expired tokens belonging to enabled users are cached
 * positively; everything else is cached as a miss for a few seconds.
 */
async function loadIdentity(prefix: string): Promise<CacheEntry> {
	const key = tokenCacheKey(prefix)
	const cached = await redisGetJson<CacheEntry>(key)
	if (cached) return cached

	const tokenCollection = await tokens()
	const token = await tokenCollection.findOne({ keyPrefix: prefix })
	if (!token || token.status !== "enabled") {
		await redisSetJson(key, { hit: false }, NEGATIVE_TTL_SEC)
		return { hit: false }
	}
	if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
		await redisSetJson(key, { hit: false }, NEGATIVE_TTL_SEC)
		return { hit: false }
	}

	const userCollection = await users()
	const user = await userCollection.findOne({ _id: token.userId })
	if (!user || user.status !== "enabled") {
		await redisSetJson(key, { hit: false }, NEGATIVE_TTL_SEC)
		return { hit: false }
	}

	const identity: Identity = {
		tokenId: token._id,
		tokenName: token.name,
		keyPrefix: token.keyPrefix,
		keyLast4: token.keyLast4,
		userId: user._id,
		username: user.username,
		role: user.role,
		group: token.group || user.group,
		unlimitedQuota: token.unlimitedQuota,
		tokenQuota: token.quota,
		userQuota: user.quota,
		allowedIps: token.allowedIps ?? [],
		allowedModels: token.allowedModels ?? [],
		rpmLimit: token.rpmLimit ?? user.rpmLimit ?? config.defaultRpm,
		tpmLimit: token.tpmLimit ?? user.tpmLimit ?? config.defaultTpm,
	}

	const entry: CacheHit = { hit: true, digest: token.keyDigest, identity }
	await redisSetJson(key, entry, config.tokenCacheTtlSec)
	return entry
}

/**
 * Authenticates a relay request.
 *
 * Throws a GatewayError on every failure. The caller should render it with
 * `errorResponse`, which will not disclose which check failed beyond the
 * coarse code.
 */
export async function authenticate(req: Request): Promise<AuthContext> {
	const startedAt = nowMs()
	const clientIp = getClientIp(req.headers)
	const credential = extractCredential(req)

	if (credential.raw.startsWith(SESSION_TOKEN_PREFIX)) {
		// A console session presented as an API key. Refusing this explicitly
		// stops a stolen dashboard cookie from being replayed against the relay.
		await digestApiKey("00000000", DUMMY_SECRET)
		return reject(startedAt, unauthorized("session tokens cannot be used as api keys"))
	}

	const parsed = parseApiKey(credential.raw)
	if (!parsed) {
		// Pay the hashing cost anyway: a malformed key must not return faster.
		await digestApiKey("00000000", DUMMY_SECRET)
		return reject(
			startedAt,
			unauthorized(
				credential.source === "none"
					? "no api key was provided"
					: "the api key is malformed",
				ErrorCode.INVALID_API_KEY,
			),
		)
	}

	const entry = await loadIdentity(parsed.prefix)
	const presented = await digestApiKey(parsed.prefix, parsed.secret)
	const expected = entry.hit ? entry.digest : DUMMY_DIGEST
	const matches = timingSafeEqualHex(presented, expected)

	// The two conditions are folded into one branch so that an unknown prefix
	// and a wrong secret are indistinguishable from the outside.
	if (!entry.hit || !matches) {
		return reject(startedAt, unauthorized("invalid api key"))
	}

	const identity = entry.identity

	if (identity.allowedIps.length > 0) {
		if (!clientIp || !matchesAnyCidr(identity.allowedIps, clientIp)) {
			return reject(
				startedAt,
				forbidden("this api key is not permitted from your address", ErrorCode.IP_NOT_ALLOWED),
			)
		}
	}

	await padAuthLatency(startedAt)

	return {
		identity,
		directives: parsed.directives,
		source: credential.source,
		clientIp,
		ipHash: await hashIp(clientIp),
		requestId: randomHex(16),
		startedAt,
	}
}

/**
 * Enforces the token's model allowlist. Called once the requested model is
 * known, which is after the body has been parsed.
 */
export function assertModelAllowed(identity: Identity, model: string): void {
	if (identity.allowedModels.length === 0) return
	for (const pattern of identity.allowedModels) {
		if (modelMatches(pattern, model)) return
	}
	throw forbidden(`this api key may not use model "${model}"`, ErrorCode.MODEL_NOT_ALLOWED)
}

/** Admin-only surfaces. Roles are ordered: root > admin > user. */
export function assertRole(identity: Identity, minimum: UserRole): void {
	const rank: Record<UserRole, number> = { user: 0, admin: 1, root: 2 }
	if (rank[identity.role] < rank[minimum]) {
		throw forbidden("this operation requires elevated privileges")
	}
}

/**
 * Applies key directives that need authorisation. A channel pin is a
 * debugging affordance and is silently dropped for non-admins rather than
 * rejected, so a leaked key cannot be used to enumerate channel ids.
 */
export function effectiveDirectives(context: AuthContext): KeyDirectives {
	const directives = context.directives
	if (context.identity.role === "user" && directives.channelId) {
		return { ...directives, channelId: undefined }
	}
	return directives
}
