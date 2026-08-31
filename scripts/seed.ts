/**
 * Seeds a fresh deployment with the minimum that makes it usable: one channel
 * with a sealed provider key, one user, and one relay key.
 *
 * Run once, against a real database. Everything it needs comes from the
 * environment, and the relay key is printed exactly once because only its digest
 * is stored.
 *
 *   SEED_USERNAME=alice \
 *   SEED_PROVIDER_BASE_URL=https://api.openai.com \
 *   SEED_PROVIDER_KEY=sk-... \
 *   npm run db:seed
 */

import { hashPassword } from "../lib/admin/password.ts"
import { createUser } from "../lib/admin/store.ts"
import { generateApiKey } from "../lib/auth/keys.ts"
import { config } from "../lib/config/env.ts"
import { channelKeys, channels, getDb, isEphemeral, tokens, users } from "../lib/db/index.ts"
import { ensureIndexes } from "../lib/db/indexes.ts"
import type { ChannelDoc, ChannelKeyDoc, TokenDoc, UserDoc } from "../lib/db/types.ts"
import { randomHex, sealSecret } from "../lib/util/crypto.ts"
import { monthBucket } from "../lib/util/time.ts"

function env(name: string, fallback = ""): string {
	const value = process.env[name]
	return typeof value === "string" && value.length > 0 ? value : fallback
}

function list(name: string): string[] {
	return env(name)
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
}

async function main(): Promise<void> {
	if (isEphemeral()) {
		console.error("MONGODB_URI is not set. Seeding an in-memory database would")
		console.error("write to a store that disappears when this process exits.")
		process.exit(1)
	}

	const providerKey = env("SEED_PROVIDER_KEY")
	const baseUrl = env("SEED_PROVIDER_BASE_URL", "https://api.openai.com")
	const channelType = env("SEED_CHANNEL_TYPE", "openai")
	const username = env("SEED_USERNAME", "owner")
	const password = env("SEED_PASSWORD")
	const models = list("SEED_MODELS")
	const group = env("SEED_GROUP", "default")

	if (providerKey && !config.channelKeyMaster) {
		console.error("CHANNEL_KEY_MASTER is not set, so a provider key cannot be sealed.")
		console.error("Set it before seeding; a plaintext key must never reach the database.")
		process.exit(1)
	}

	const db = await getDb()
	const applied = await ensureIndexes(db, [monthBucket()])
	console.log(`indexes ensured (${applied.length} collections)`)

	// -- user --------------------------------------------------------------
	let user: UserDoc | null = await (await users()).findOne({ username })
	if (user) {
		console.log(`user "${username}" already exists, reusing it`)
	} else {
		user = await createUser({
			username,
			displayName: username,
			role: env("SEED_ROLE", "root"),
			group,
			quota: Number(env("SEED_QUOTA", "50000000")),
		})
		console.log(`created user "${username}" (${user.role})`)
	}

	if (password) {
		const record = await hashPassword(password)
		await (await users()).updateOne(
			{ _id: user._id },
			{ $set: { passwordHash: record.passwordHash, passwordSalt: record.passwordSalt } },
		)
		console.log("console password set")
	}

	// -- relay key ---------------------------------------------------------
	const generated = await generateApiKey()
	const now = new Date()
	const token: TokenDoc = {
		_id: randomHex(12),
		userId: user._id,
		name: env("SEED_TOKEN_NAME", "seed key"),
		keyPrefix: generated.prefix,
		keyDigest: generated.digest,
		keyLast4: generated.last4,
		status: "enabled",
		quota: 0,
		usedQuota: 0,
		unlimitedQuota: true,
		expiresAt: null,
		allowedIps: [],
		allowedModels: [],
		createdAt: now,
		updatedAt: now,
	}
	await (await tokens()).insertOne(token)

	// -- channel -----------------------------------------------------------
	if (providerKey) {
		const channel: ChannelDoc = {
			_id: randomHex(12),
			name: env("SEED_CHANNEL_NAME", `${channelType} (seeded)`),
			type: channelType as ChannelDoc["type"],
			baseUrl,
			status: "enabled",
			priority: 10,
			weight: 10,
			groups: [group],
			// Empty means "every model this provider offers".
			models,
			modelMapping: {},
			headers: {},
			autoDisabled: false,
			failCount: 0,
			config: {},
			createdAt: now,
			updatedAt: now,
		}
		await (await channels()).insertOne(channel)

		const sealed = await sealSecret(
			providerKey,
			config.channelKeyMaster,
			config.channelKeyVersion,
		)
		const keyDoc: ChannelKeyDoc = {
			_id: randomHex(12),
			channelId: channel._id,
			cipher: sealed.cipher,
			iv: sealed.iv,
			authTag: sealed.authTag,
			keyVersion: sealed.keyVersion,
			fingerprint: sealed.fingerprint,
			status: "enabled",
			index: 0,
			failCount: 0,
			createdAt: now,
		}
		await (await channelKeys()).insertOne(keyDoc)
		console.log(`created channel "${channel.name}" with one sealed key`)
	} else {
		console.log("no SEED_PROVIDER_KEY given, so no channel was created")
		console.log("add one in the console before the relay can serve traffic")
	}

	console.log("")
	console.log("relay key (shown once, only its digest is stored):")
	console.log(`  ${generated.key}`)
	console.log("")
	console.log("try it:")
	console.log(`  curl $BASE_URL/v1/models -H "Authorization: Bearer ${generated.key}"`)
	process.exit(0)
}

await main()
