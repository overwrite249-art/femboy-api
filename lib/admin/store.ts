/**
 * Control-plane data operations for the three entities that carry authority:
 * users, tokens, and channels.
 *
 * This layer is deliberately HTTP-free so it can be driven from the admin API,
 * the bootstrap script, or a test without a request object. It owns three
 * invariants that the HTTP layer cannot enforce on its own:
 *
 *  - A plaintext credential exists exactly once, as a return value. Tokens are
 *    stored as digests (GW-002 for channel keys, the same principle for user
 *    keys) and there is no code path that can read one back.
 *  - Anything that changes what a channel can serve invalidates the ability
 *    cache, because a stale cache would keep routing to a channel the operator
 *    just took away.
 *  - Anything that changes a token invalidates that token's identity cache, or
 *    a revoked key would keep working until the TTL expired.
 */

import { invalidateTokenCache } from "../auth/authenticate.ts"
import { digestApiKey, generateApiKey, maskKey } from "../auth/keys.ts"
import { config } from "../config/env.ts"
import { channelKeys, channels, tokens, users } from "../db/index.ts"
import type {
	ChannelDoc,
	ChannelKeyDoc,
	ChannelType,
	EntityStatus,
	TokenDoc,
	UserDoc,
	UserRole,
} from "../db/types.ts"
import { invalidateAbilities, rebuildAbilities } from "../routing/abilities.ts"
import { invalidRequest, notFound } from "../http/errors.ts"
import { randomAlphanumeric, randomHex, sealSecret } from "../util/crypto.ts"

export type ListOptions = { limit?: number; skip?: number }

function page(options: ListOptions): { limit: number; skip: number } {
	const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200)
	const skip = Math.max(Math.floor(options.skip ?? 0), 0)
	return { limit, skip }
}

function requireText(value: unknown, field: string, max = 200): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw invalidRequest(`${field} is required`, field)
	}
	if (value.length > max) throw invalidRequest(`${field} is too long`, field)
	return value.trim()
}

function optionalNumber(value: unknown, field: string, fallback: number): number {
	if (value === undefined || value === null) return fallback
	const parsed = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(parsed)) throw invalidRequest(`${field} must be a number`, field)
	return parsed
}

function stringList(value: unknown, field: string): string[] {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value)) throw invalidRequest(`${field} must be an array`, field)
	if (value.length > 200) throw invalidRequest(`${field} has too many entries`, field)
	return value.map((entry, index) => requireText(entry, `${field}[${index}]`))
}

const ROLES: UserRole[] = ["user", "admin", "root"]
const STATUSES: EntityStatus[] = ["enabled", "disabled", "deleted"]

function asRole(value: unknown, fallback: UserRole): UserRole {
	if (value === undefined || value === null) return fallback
	if (typeof value !== "string" || !ROLES.includes(value as UserRole)) {
		throw invalidRequest("role must be user, admin, or root", "role")
	}
	return value as UserRole
}

function asStatus(value: unknown, fallback: EntityStatus): EntityStatus {
	if (value === undefined || value === null) return fallback
	if (typeof value !== "string" || !STATUSES.includes(value as EntityStatus)) {
		throw invalidRequest("status must be enabled, disabled, or deleted", "status")
	}
	return value as EntityStatus
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function listUsers(options: ListOptions = {}): Promise<UserDoc[]> {
	const { limit, skip } = page(options)
	return await (await users()).find({}, { sort: { createdAt: -1 }, limit, skip })
}

export async function getUser(id: string): Promise<UserDoc> {
	const user = await (await users()).findOne({ _id: id })
	if (!user) throw notFound("user not found")
	return user
}

export async function findUserByUsername(username: string): Promise<UserDoc | null> {
	return await (await users()).findOne({ username })
}

export async function createUser(input: Record<string, unknown>): Promise<UserDoc> {
	const username = requireText(input.username, "username", 64)
	const existing = await findUserByUsername(username)
	if (existing) throw invalidRequest("that username is taken", "username")

	const now = new Date()
	const doc: UserDoc = {
		_id: randomHex(12),
		username,
		displayName: typeof input.displayName === "string" && input.displayName.trim()
			? input.displayName.trim().slice(0, 200)
			: username,
		email: typeof input.email === "string" ? input.email.trim().slice(0, 200) : "",
		role: asRole(input.role, "user"),
		status: asStatus(input.status, "enabled"),
		group: typeof input.group === "string" && input.group.trim() ? input.group.trim() : "default",
		quota: optionalNumber(input.quota, "quota", 0),
		usedQuota: 0,
		requestCount: 0,
		createdAt: now,
		updatedAt: now,
	}
	await (await users()).insertOne(doc)
	return doc
}

export async function updateUser(id: string, patch: Record<string, unknown>): Promise<UserDoc> {
	const user = await getUser(id)
	const update: Record<string, unknown> = { updatedAt: new Date() }

	if (patch.displayName !== undefined) {
		update.displayName = requireText(patch.displayName, "displayName")
	}
	if (patch.email !== undefined) update.email = String(patch.email).slice(0, 200)
	if (patch.role !== undefined) update.role = asRole(patch.role, user.role)
	if (patch.status !== undefined) update.status = asStatus(patch.status, user.status)
	if (patch.group !== undefined) update.group = requireText(patch.group, "group", 64)
	if (patch.quota !== undefined) update.quota = optionalNumber(patch.quota, "quota", user.quota)
	if (patch.rpmLimit !== undefined) update.rpmLimit = optionalNumber(patch.rpmLimit, "rpmLimit", 0)
	if (patch.tpmLimit !== undefined) update.tpmLimit = optionalNumber(patch.tpmLimit, "tpmLimit", 0)

	await (await users()).updateOne({ _id: id }, { $set: update })

	// A disabled user's tokens must stop working now, not when the cache expires.
	const owned = await (await tokens()).find({ userId: id }, { limit: 200 })
	for (const token of owned) await invalidateTokenCache(token.keyPrefix)

	return await getUser(id)
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type TokenView = Omit<TokenDoc, "keyDigest"> & { masked: string }

/** Never let a digest out of the process, even to an admin. */
export function tokenView(token: TokenDoc): TokenView {
	const { keyDigest: _digest, ...rest } = token
	return { ...rest, masked: maskKey(token.keyPrefix, token.keyLast4) }
}

export async function listTokens(
	userId?: string,
	options: ListOptions = {},
): Promise<TokenView[]> {
	const { limit, skip } = page(options)
	const filter = userId ? { userId } : {}
	const rows = await (await tokens()).find(filter, { sort: { createdAt: -1 }, limit, skip })
	return rows.map(tokenView)
}

export async function getToken(id: string): Promise<TokenDoc> {
	const token = await (await tokens()).findOne({ _id: id })
	if (!token) throw notFound("token not found")
	return token
}

/**
 * Mints a token. The plaintext key is returned once and never stored; if the
 * caller loses it, the only remedy is to issue another one.
 */
export async function createToken(
	input: Record<string, unknown>,
): Promise<{ token: TokenView; key: string }> {
	const userId = requireText(input.userId, "userId")
	await getUser(userId)

	const generated = await generateApiKey()
	const now = new Date()
	const expiresAt =
		input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === ""
			? null
			: new Date(String(input.expiresAt))
	if (expiresAt && Number.isNaN(expiresAt.getTime())) {
		throw invalidRequest("expiresAt is not a valid date", "expiresAt")
	}

	const doc: TokenDoc = {
		_id: randomHex(12),
		userId,
		name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : "key",
		keyPrefix: generated.prefix,
		keyDigest: generated.digest,
		keyLast4: generated.last4,
		status: "enabled",
		quota: optionalNumber(input.quota, "quota", 0),
		usedQuota: 0,
		unlimitedQuota: input.unlimitedQuota === true,
		expiresAt,
		allowedIps: stringList(input.allowedIps, "allowedIps"),
		allowedModels: stringList(input.allowedModels, "allowedModels"),
		createdAt: now,
		updatedAt: now,
	}
	await (await tokens()).insertOne(doc)
	return { token: tokenView(doc), key: generated.key }
}

export async function updateToken(
	id: string,
	patch: Record<string, unknown>,
): Promise<TokenView> {
	const token = await getToken(id)
	const update: Record<string, unknown> = { updatedAt: new Date() }

	if (patch.name !== undefined) update.name = requireText(patch.name, "name", 120)
	if (patch.status !== undefined) update.status = asStatus(patch.status, token.status)
	if (patch.quota !== undefined) update.quota = optionalNumber(patch.quota, "quota", token.quota)
	if (patch.unlimitedQuota !== undefined) update.unlimitedQuota = patch.unlimitedQuota === true
	if (patch.allowedIps !== undefined) update.allowedIps = stringList(patch.allowedIps, "allowedIps")
	if (patch.allowedModels !== undefined) {
		update.allowedModels = stringList(patch.allowedModels, "allowedModels")
	}
	if (patch.expiresAt !== undefined) {
		if (patch.expiresAt === null || patch.expiresAt === "") update.expiresAt = null
		else {
			const parsed = new Date(String(patch.expiresAt))
			if (Number.isNaN(parsed.getTime())) {
				throw invalidRequest("expiresAt is not a valid date", "expiresAt")
			}
			update.expiresAt = parsed
		}
	}

	await (await tokens()).updateOne({ _id: id }, { $set: update })
	await invalidateTokenCache(token.keyPrefix)
	return tokenView(await getToken(id))
}

export async function deleteToken(id: string): Promise<void> {
	const token = await getToken(id)
	await (await tokens()).deleteOne({ _id: id })
	await invalidateTokenCache(token.keyPrefix)
}

/**
 * Rotates a token in place: same row, same limits, new secret. Returns the new
 * plaintext once. The old key stops working as soon as the cache is dropped,
 * which happens before this function returns.
 */
export async function rotateToken(id: string): Promise<{ token: TokenView; key: string }> {
	const token = await getToken(id)
	const generated = await generateApiKey()
	await (await tokens()).updateOne(
		{ _id: id },
		{
			$set: {
				keyPrefix: generated.prefix,
				keyDigest: generated.digest,
				keyLast4: generated.last4,
				updatedAt: new Date(),
			},
		},
	)
	await invalidateTokenCache(token.keyPrefix)
	await invalidateTokenCache(generated.prefix)
	return { token: tokenView(await getToken(id)), key: generated.key }
}

/** Used by the bootstrap script: proves a digest matches without storing one. */
export async function digestFor(prefix: string, secret: string): Promise<string> {
	return await digestApiKey(prefix, secret)
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type ChannelView = ChannelDoc & { keyCount: number; keyFingerprints: string[] }

export async function listChannels(options: ListOptions = {}): Promise<ChannelView[]> {
	const { limit, skip } = page(options)
	const rows = await (await channels()).find({}, { sort: { priority: -1 }, limit, skip })
	const keyCollection = await channelKeys()
	const views: ChannelView[] = []
	for (const channel of rows) {
		const keys = await keyCollection.find({ channelId: channel._id }, { limit: 100 })
		views.push({
			...channel,
			keyCount: keys.filter((key) => key.status === "enabled").length,
			// Fingerprints are safe to show: they identify a key without revealing it.
			keyFingerprints: keys.map((key) => key.fingerprint),
		})
	}
	return views
}

export async function getChannel(id: string): Promise<ChannelDoc> {
	const channel = await (await channels()).findOne({ _id: id })
	if (!channel) throw notFound("channel not found")
	return channel
}

function asChannelType(value: unknown): ChannelType {
	const text = requireText(value, "type", 40)
	return text as ChannelType
}

function asMapping(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw invalidRequest("modelMapping must be an object", "modelMapping")
	}
	const out: Record<string, string> = {}
	for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
		out[requireText(from, "modelMapping key", 200)] = requireText(to, "modelMapping value", 200)
	}
	return out
}

function asHeaders(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw invalidRequest("headers must be an object", "headers")
	}
	const out: Record<string, string> = {}
	for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
		const lower = requireText(name, "header name", 120).toLowerCase()
		// The relay sets auth last so a channel header cannot override credentials,
		// but there is no reason to accept one here either.
		if (lower === "authorization" || lower === "x-api-key" || lower === "x-goog-api-key") {
			throw invalidRequest("credential headers are managed by the gateway", "headers")
		}
		out[lower] = requireText(entry, "header value", 1000)
	}
	return out
}

async function sealKeysFor(channelId: string, secrets: string[]): Promise<ChannelKeyDoc[]> {
	const master = config.channelKeyMaster
	if (!master) {
		throw invalidRequest("CHANNEL_KEY_MASTER is not configured, so keys cannot be sealed")
	}
	const docs: ChannelKeyDoc[] = []
	let index = 0
	for (const secret of secrets) {
		const plaintext = requireText(secret, "key", 4096)
		const sealed = await sealSecret(plaintext, master, config.channelKeyVersion)
		docs.push({
			_id: randomHex(12),
			channelId,
			cipher: sealed.cipher,
			iv: sealed.iv,
			authTag: sealed.authTag,
			keyVersion: sealed.keyVersion,
			fingerprint: sealed.fingerprint,
			status: "enabled",
			index,
			failCount: 0,
			createdAt: new Date(),
		})
		index += 1
	}
	return docs
}

export async function createChannel(input: Record<string, unknown>): Promise<ChannelView> {
	const secrets = stringList(input.keys, "keys")
	if (secrets.length === 0) throw invalidRequest("at least one key is required", "keys")

	const now = new Date()
	const id = randomHex(12)
	const doc: ChannelDoc = {
		_id: id,
		name: requireText(input.name, "name", 120),
		type: asChannelType(input.type),
		baseUrl: requireText(input.baseUrl, "baseUrl", 500),
		status: asStatus(input.status, "enabled"),
		priority: optionalNumber(input.priority, "priority", 0),
		weight: optionalNumber(input.weight, "weight", 0),
		groups: stringList(input.groups, "groups"),
		models: stringList(input.models, "models"),
		modelMapping: asMapping(input.modelMapping),
		headers: asHeaders(input.headers),
		autoDisabled: false,
		failCount: 0,
		config: {},
		createdAt: now,
		updatedAt: now,
	}
	if (doc.groups.length === 0) doc.groups = ["default"]
	if (typeof input.testModel === "string" && input.testModel.trim()) {
		doc.testModel = input.testModel.trim()
	}

	const sealed = await sealKeysFor(id, secrets)
	await (await channels()).insertOne(doc)
	await (await channelKeys()).insertMany(sealed)
	await rebuildAbilities()
	await invalidateAbilities()

	return {
		...doc,
		keyCount: sealed.length,
		keyFingerprints: sealed.map((key) => key.fingerprint),
	}
}

export async function updateChannel(
	id: string,
	patch: Record<string, unknown>,
): Promise<ChannelDoc> {
	const channel = await getChannel(id)
	const update: Record<string, unknown> = { updatedAt: new Date() }

	if (patch.name !== undefined) update.name = requireText(patch.name, "name", 120)
	if (patch.baseUrl !== undefined) update.baseUrl = requireText(patch.baseUrl, "baseUrl", 500)
	if (patch.status !== undefined) update.status = asStatus(patch.status, channel.status)
	if (patch.priority !== undefined) {
		update.priority = optionalNumber(patch.priority, "priority", channel.priority)
	}
	if (patch.weight !== undefined) {
		update.weight = optionalNumber(patch.weight, "weight", channel.weight)
	}
	if (patch.groups !== undefined) update.groups = stringList(patch.groups, "groups")
	if (patch.models !== undefined) update.models = stringList(patch.models, "models")
	if (patch.modelMapping !== undefined) update.modelMapping = asMapping(patch.modelMapping)
	if (patch.headers !== undefined) update.headers = asHeaders(patch.headers)
	if (patch.testModel !== undefined) update.testModel = String(patch.testModel).slice(0, 200)
	if (patch.rpmLimit !== undefined) update.rpmLimit = optionalNumber(patch.rpmLimit, "rpmLimit", 0)

	// Re-enabling a channel clears the breaker, otherwise the operator's fix
	// would appear to do nothing until the failure count decayed.
	if (patch.autoDisabled === false || update.status === "enabled") {
		update.autoDisabled = false
		update.failCount = 0
	}

	await (await channels()).updateOne({ _id: id }, { $set: update })
	await rebuildAbilities()
	await invalidateAbilities()
	return await getChannel(id)
}

export async function replaceChannelKeys(id: string, secrets: string[]): Promise<number> {
	await getChannel(id)
	if (secrets.length === 0) throw invalidRequest("at least one key is required", "keys")
	const sealed = await sealKeysFor(id, secrets)
	const collection = await channelKeys()
	await collection.deleteMany({ channelId: id })
	await collection.insertMany(sealed)
	return sealed.length
}

export async function deleteChannel(id: string): Promise<void> {
	await getChannel(id)
	await (await channels()).deleteOne({ _id: id })
	await (await channelKeys()).deleteMany({ channelId: id })
	await rebuildAbilities()
	await invalidateAbilities()
}

/** Generates a memorable-but-random group name for a new tenant. */
export function suggestGroupName(): string {
	return "grp-" + randomAlphanumeric(8).toLowerCase()
}
