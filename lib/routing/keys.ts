/**
 * Channel credential selection.
 *
 * A channel usually holds several upstream keys so it can spread load and
 * survive one of them being rate limited. Keys are stored sealed and are only
 * opened at the moment of use, so a database dump is not a credential dump
 * (GW-002).
 *
 * Rotation is a shared counter rather than per-process state: in a serverless
 * runtime every invocation would otherwise start at the same key and the
 * others would never be used.
 */

import { config } from "../config/env.ts"
import { channelKeys } from "../db/index.ts"
import type { ChannelKeyDoc } from "../db/types.ts"
import { configurationError } from "../http/errors.ts"
import { runScript } from "../redis/client.ts"
import { K } from "../redis/keys.ts"
import { openSecret } from "../util/crypto.ts"

export type SelectedKey = {
	keyId: string
	/** The decrypted upstream credential. Never logged, never persisted. */
	secret: string
	index: number
	fingerprint: string
}

/** Enabled keys for a channel, in stable order. */
export async function listChannelKeys(channelId: string): Promise<ChannelKeyDoc[]> {
	const collection = await channelKeys()
	return collection.find({ channelId, status: "enabled" }, { sort: { index: 1 }, limit: 100 })
}

/**
 * Picks the next credential for a channel, round-robin across invocations.
 *
 * @param skipFingerprints keys already tried during this request, so a retry
 *   does not reuse the credential that just failed
 */
export async function pickChannelKey(
	channelId: string,
	skipFingerprints: string[] = [],
): Promise<SelectedKey> {
	const all = await listChannelKeys(channelId)
	const usable = all.filter((key) => !skipFingerprints.includes(key.fingerprint))
	// If every key has been tried, fall back to the full set rather than
	// failing outright; the caller's retry budget bounds the damage.
	const pool = usable.length > 0 ? usable : all

	if (pool.length === 0) {
		throw configurationError(`channel ${channelId} has no enabled keys`)
	}

	let offset = 0
	try {
		const result = (await runScript(
			"nextKey",
			[K.channelKeyIndex(channelId)],
			[pool.length],
		)) as unknown
		const n = Number(Array.isArray(result) ? result[0] : result)
		if (Number.isFinite(n) && n >= 0) offset = n % pool.length
	} catch {
		// A counter failure degrades to the first key, not to an outage.
		offset = 0
	}

	const chosen = pool[offset]
	const secret = await openSecret(
		{
			cipher: chosen.cipher,
			iv: chosen.iv,
			authTag: chosen.authTag,
			keyVersion: chosen.keyVersion,
			fingerprint: chosen.fingerprint,
		},
		config.channelKeyMaster,
	)

	return {
		keyId: chosen._id,
		secret,
		index: chosen.index,
		fingerprint: chosen.fingerprint,
	}
}

/** Records that a credential failed, for the admin console. */
export async function markKeyFailure(keyId: string): Promise<void> {
	try {
		const collection = await channelKeys()
		await collection.updateOne({ _id: keyId }, { $inc: { failCount: 1 } })
	} catch {
		// Bookkeeping only.
	}
}

/** Records successful use, so an operator can spot idle credentials. */
export async function markKeyUsed(keyId: string): Promise<void> {
	try {
		const collection = await channelKeys()
		await collection.updateOne({ _id: keyId }, { $set: { lastUsedAt: new Date() } })
	} catch {
		// Bookkeeping only.
	}
}
