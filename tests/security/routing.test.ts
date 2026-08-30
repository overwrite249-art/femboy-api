import test from "node:test"
import assert from "node:assert/strict"

process.env.CHANNEL_KEY_MASTER = "unit-test-master-key-0123456789abcdef"
process.env.CHANNEL_KEY_VERSION = "1"
// Auto-disable is exercised in its own tests; leaving it on would permanently
// remove channels midway through the breaker tests and mask what they check.
process.env.CHANNEL_AUTO_DISABLE_FAILS = "0"

import { config } from "../../lib/config/env.ts"
import { channelKeys, channels, modelMappings, setDb } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import type { ChannelDoc } from "../../lib/db/types.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { sealSecret } from "../../lib/util/crypto.ts"
import {
	candidatesFor,
	electFrom,
	isChannelOpen,
	pickChannelKey,
	rebuildAbilities,
	recordChannelOutcome,
	resolveModel,
	selectChannel,
	serves,
	tiersOf,
	weightedPick,
	WEIGHT_FLOOR,
} from "../../lib/routing/index.ts"

/** Every routing failure surfaces as the same opaque 503. */
const UNAVAILABLE = /no channel is able to serve/i

function channelDoc(overrides: Partial<ChannelDoc> & { _id: string }): ChannelDoc {
	return {
		name: overrides._id,
		type: "openai",
		baseUrl: "https://api.example.com",
		status: "enabled",
		priority: 0,
		weight: 0,
		groups: ["default"],
		models: ["gpt-4o"],
		modelMapping: {},
		headers: {},
		autoDisabled: false,
		failCount: 0,
		config: {},
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

async function fresh(docs: ChannelDoc[] = []) {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	const collection = await channels()
	for (const doc of docs) await collection.insertOne(doc)
}

test("tiers are ordered by descending priority", () => {
	const tiers = tiersOf([
		{ channelId: "low", priority: 1, weight: 0 },
		{ channelId: "high", priority: 10, weight: 0 },
		{ channelId: "high2", priority: 10, weight: 0 },
		{ channelId: "mid", priority: 5, weight: 0 },
	])
	assert.deepEqual(
		tiers.map((t) => t.map((c) => c.channelId)),
		[["high", "high2"], ["mid"], ["low"]],
	)
})

test("retries walk down the tiers and then stay put", () => {
	const candidates = [
		{ channelId: "a", priority: 10, weight: 0 },
		{ channelId: "b", priority: 5, weight: 0 },
		{ channelId: "c", priority: 1, weight: 0 },
	]
	assert.equal(electFrom(candidates, { attempt: 0 })?.channelId, "a")
	assert.equal(electFrom(candidates, { attempt: 1 })?.channelId, "b")
	assert.equal(electFrom(candidates, { attempt: 2 })?.channelId, "c")
	// Past the last tier the clamp must hold rather than wrap back to the top,
	// which would send a retry straight back to the channel that just failed.
	assert.equal(electFrom(candidates, { attempt: 3 })?.channelId, "c")
	assert.equal(electFrom(candidates, { attempt: 99 })?.channelId, "c")
})

test("weighting uses weight plus a floor so nothing starves", () => {
	const tier = [
		{ channelId: "zero", priority: 0, weight: 0 },
		{ channelId: "heavy", priority: 0, weight: 90 },
	]
	// Total is (0 + 10) + (90 + 10) = 110.
	assert.equal(weightedPick(tier, () => 0)?.channelId, "zero")
	assert.equal(weightedPick(tier, () => 9 / 110)?.channelId, "zero")
	assert.equal(weightedPick(tier, () => 11 / 110)?.channelId, "heavy")
	assert.equal(weightedPick(tier, () => 0.999)?.channelId, "heavy")

	// A zero-weight channel still gets its floor share over many draws.
	let zeroHits = 0
	for (let i = 0; i < 1100; i++) {
		if (weightedPick(tier, () => i / 1100)?.channelId === "zero") zeroHits++
	}
	assert.ok(zeroHits > 50 && zeroHits < 150, `expected roughly 100 hits, got ${zeroHits}`)
	assert.equal(WEIGHT_FLOOR, 10)
})

test("an empty candidate set elects nothing rather than guessing", () => {
	assert.equal(electFrom([], {}), null)
	assert.equal(weightedPick([], () => 0.5), null)
})

test("a group that was never granted is never served", async () => {
	const channel = channelDoc({ _id: "c1", groups: ["premium"], models: ["gpt-4o"] })
	assert.equal(serves(channel, "premium", "gpt-4o"), true)
	// The core isolation property: another group must not reach this channel.
	assert.equal(serves(channel, "default", "gpt-4o"), false)
	// Nor another model.
	assert.equal(serves(channel, "premium", "claude-3-opus"), false)
	// A channel with no groups grants nothing; absence of a grant is not a grant.
	assert.equal(serves(channelDoc({ _id: "c2", groups: [] }), "default", "gpt-4o"), false)
	// A disabled channel serves nobody, whatever it lists.
	assert.equal(serves(channelDoc({ _id: "c3", status: "disabled" }), "default", "gpt-4o"), false)
	// An empty model list is the documented catch-all.
	assert.equal(serves(channelDoc({ _id: "c4", models: [] }), "default", "anything"), true)

	await fresh([channel])
	await assert.rejects(() => selectChannel({ group: "default", model: "gpt-4o" }), UNAVAILABLE)
})

test("selection prefers the highest priority channel", async () => {
	await fresh([
		channelDoc({ _id: "cheap", priority: 1 }),
		channelDoc({ _id: "premium", priority: 100 }),
	])
	const selection = await selectChannel({ group: "default", model: "gpt-4o" })
	assert.equal(selection.channel._id, "premium")
	assert.equal(selection.considered, 2)
})

test("an open breaker removes a channel from rotation", async () => {
	await fresh([
		channelDoc({ _id: "flaky", priority: 100 }),
		channelDoc({ _id: "steady", priority: 1 }),
	])

	// Fail the preferred channel until the breaker trips.
	let tripped = false
	for (let i = 0; i < config.channelFailureThreshold; i++) {
		tripped = (await recordChannelOutcome("flaky", false)).tripped
	}
	assert.ok(tripped, "breaker should trip at the configured threshold")
	assert.equal(await isChannelOpen("flaky"), true)

	// Traffic moves to the lower tier even though it is less preferred.
	assert.equal((await selectChannel({ group: "default", model: "gpt-4o" })).channel._id, "steady")

	// One success clears the counter and puts it straight back in rotation.
	await recordChannelOutcome("flaky", true)
	assert.equal(await isChannelOpen("flaky"), false)
	assert.equal((await selectChannel({ group: "default", model: "gpt-4o" })).channel._id, "flaky")
})

test("intermittent failures never accumulate into a trip", async () => {
	await fresh([channelDoc({ _id: "c1" })])
	for (let i = 0; i < config.channelFailureThreshold * 3; i++) {
		await recordChannelOutcome("c1", false)
		await recordChannelOutcome("c1", true)
	}
	assert.equal(await isChannelOpen("c1"), false)
})

test("every channel unhealthy is a clean failure, not a silent retry", async () => {
	await fresh([channelDoc({ _id: "only" })])
	for (let i = 0; i < config.channelFailureThreshold; i++) {
		await recordChannelOutcome("only", false)
	}
	assert.equal(await isChannelOpen("only"), true)
	// The channel is still enabled - it is temporarily out, not removed.
	assert.equal((await (await channels()).findOne({ _id: "only" }))?.status, "enabled")
	await assert.rejects(() => selectChannel({ group: "default", model: "gpt-4o" }), UNAVAILABLE)
})

test("a persistently broken channel is disabled outright", async () => {
	await fresh([channelDoc({ _id: "broken" })])
	process.env.CHANNEL_AUTO_DISABLE_FAILS = String(config.channelFailureThreshold)
	try {
		let autoDisabled = false
		for (let i = 0; i < config.channelFailureThreshold; i++) {
			autoDisabled = (await recordChannelOutcome("broken", false)).autoDisabled
		}
		assert.ok(autoDisabled, "should have been auto-disabled")

		const stored = await (await channels()).findOne({ _id: "broken" })
		assert.equal(stored?.status, "disabled")
		assert.equal(stored?.autoDisabled, true)
	} finally {
		process.env.CHANNEL_AUTO_DISABLE_FAILS = "0"
	}
})

test("permanent removal never precedes the temporary cooldown", async () => {
	await fresh([channelDoc({ _id: "c1" })])
	// An aggressive auto-disable set below the breaker threshold. Taken
	// literally this would delete the channel from service before it ever got
	// the recoverable cooldown, so the floor must hold it back.
	process.env.CHANNEL_AUTO_DISABLE_FAILS = "1"
	try {
		const threshold = config.channelFailureThreshold
		for (let i = 0; i < threshold - 1; i++) {
			const outcome = await recordChannelOutcome("c1", false)
			assert.equal(
				outcome.autoDisabled,
				false,
				`disabled after ${i + 1} failures, before the breaker opened`,
			)
		}
		assert.equal((await (await channels()).findOne({ _id: "c1" }))?.status, "enabled")

		const final = await recordChannelOutcome("c1", false)
		assert.ok(final.tripped, "breaker should open on the threshold failure")
		assert.ok(final.autoDisabled, "and only then may the channel be removed")
	} finally {
		process.env.CHANNEL_AUTO_DISABLE_FAILS = "0"
	}
})

test("already-tried channels are excluded from a retry", async () => {
	await fresh([
		channelDoc({ _id: "first", priority: 10 }),
		channelDoc({ _id: "second", priority: 10 }),
	])
	const selection = await selectChannel({
		group: "default",
		model: "gpt-4o",
		excludeChannelIds: ["first"],
	})
	assert.equal(selection.channel._id, "second")

	await assert.rejects(
		() =>
			selectChannel({
				group: "default",
				model: "gpt-4o",
				excludeChannelIds: ["first", "second"],
			}),
		UNAVAILABLE,
	)
})

test("affinity pins a conversation and outranks weight", async () => {
	await fresh([
		channelDoc({ _id: "a", priority: 10, weight: 1 }),
		channelDoc({ _id: "b", priority: 10, weight: 1000 }),
	])

	// Candidates are ordered by weight within a tier, so "b" comes first and a
	// draw near the top of the range lands on "a".
	assert.deepEqual(
		(await candidatesFor("default", "gpt-4o")).map((c) => c.channelId),
		["b", "a"],
	)

	const first = await selectChannel({
		group: "default",
		model: "gpt-4o",
		affinityHash: "conv-1",
		random: () => 0.999,
	})
	assert.equal(first.channel._id, "a")

	// The pin holds even though "b" is ~90x more likely by weight.
	for (let i = 0; i < 5; i++) {
		const next = await selectChannel({
			group: "default",
			model: "gpt-4o",
			affinityHash: "conv-1",
			random: () => 0,
		})
		assert.equal(next.channel._id, "a")
	}

	// A different conversation is not pinned to it.
	const other = await selectChannel({
		group: "default",
		model: "gpt-4o",
		affinityHash: "conv-2",
		random: () => 0,
	})
	assert.equal(other.channel._id, "b")

	// A retry must not honour the pin, or it would return to the same channel.
	const retry = await selectChannel({
		group: "default",
		model: "gpt-4o",
		affinityHash: "conv-1",
		attempt: 0,
		excludeChannelIds: ["a"],
		random: () => 0,
	})
	assert.equal(retry.channel._id, "b")
})

test("a stale ability row cannot authorise a channel", async () => {
	await fresh([channelDoc({ _id: "c1", groups: ["default"] })])
	await rebuildAbilities()
	assert.equal((await candidatesFor("default", "gpt-4o")).length, 1)

	// Revoke the group without rebuilding: the cached row still points here,
	// but the channel is the authority and must refuse.
	await (await channels()).updateOne({ _id: "c1" }, { $set: { groups: ["premium"] } })
	assert.equal((await candidatesFor("default", "gpt-4o")).length, 1)
	await assert.rejects(() => selectChannel({ group: "default", model: "gpt-4o" }), UNAVAILABLE)
})

test("a channel disabled after the rebuild stops being selected", async () => {
	await fresh([channelDoc({ _id: "c1" })])
	await rebuildAbilities()
	await (await channels()).updateOne({ _id: "c1" }, { $set: { status: "disabled" } })
	await assert.rejects(() => selectChannel({ group: "default", model: "gpt-4o" }), UNAVAILABLE)
})

test("rebuilding expands every group and model pair", async () => {
	await fresh([
		channelDoc({ _id: "c1", groups: ["default", "premium"], models: ["gpt-4o", "gpt-4o-mini"] }),
		channelDoc({ _id: "c2", status: "disabled" }),
	])
	assert.equal(await rebuildAbilities(), 4)
	assert.equal((await candidatesFor("premium", "gpt-4o-mini")).length, 1)
	// The disabled channel contributes nothing.
	assert.equal((await candidatesFor("default", "gpt-4o")).length, 1)
})

test("model mapping rewrites the upstream name and nothing else", async () => {
	await fresh()
	const channel = channelDoc({ _id: "c1", modelMapping: { "gpt-4o": "internal-4o-v2" } })
	const resolved = await resolveModel("gpt-4o", channel)
	assert.equal(resolved.mapped, "internal-4o-v2")
	// GW-013: the requested name is what the user is billed for.
	assert.equal(resolved.requested, "gpt-4o")
})

test("a channel mapping overrides the global table", async () => {
	await fresh()
	const mappings = await modelMappings()
	await mappings.insertOne({ _id: "m1", from: "gpt-4o", to: "global-target", createdAt: new Date() })

	const plain = channelDoc({ _id: "c1" })
	assert.equal((await resolveModel("gpt-4o", plain)).mapped, "global-target")

	const override = channelDoc({ _id: "c2", modelMapping: { "gpt-4o": "channel-target" } })
	assert.equal((await resolveModel("gpt-4o", override)).mapped, "channel-target")

	// An unmapped model passes through untouched.
	assert.equal((await resolveModel("claude-3-opus", plain)).mapped, "claude-3-opus")
})

test("a circular mapping resolves instead of looping", async () => {
	await fresh()
	const mappings = await modelMappings()
	await mappings.insertOne({ _id: "m1", from: "a", to: "b", createdAt: new Date() })
	await mappings.insertOne({ _id: "m2", from: "b", to: "a", createdAt: new Date() })
	// Each layer applies at most once, so this terminates.
	assert.equal((await resolveModel("a", channelDoc({ _id: "c1" }))).mapped, "b")
})

test("channel keys rotate and are only decrypted at use", async () => {
	await fresh([channelDoc({ _id: "c1" })])
	const keys = await channelKeys()
	const secrets = ["sk-upstream-one", "sk-upstream-two", "sk-upstream-three"]

	for (let i = 0; i < secrets.length; i++) {
		const sealed = await sealSecret(secrets[i], config.channelKeyMaster, config.channelKeyVersion)
		await keys.insertOne({
			_id: `k${i}`,
			channelId: "c1",
			cipher: sealed.cipher,
			iv: sealed.iv,
			authTag: sealed.authTag,
			keyVersion: sealed.keyVersion,
			fingerprint: sealed.fingerprint,
			status: "enabled",
			index: i,
			failCount: 0,
			createdAt: new Date(),
		})
	}

	// The stored form must not contain the credential (GW-002).
	const stored = await keys.findOne({ _id: "k0" })
	assert.ok(stored)
	assert.equal(JSON.stringify(stored).includes("sk-upstream-one"), false)

	// Successive calls cycle through the pool rather than pinning to one key.
	const seen: string[] = []
	for (let i = 0; i < 6; i++) seen.push((await pickChannelKey("c1")).secret)
	assert.equal(new Set(seen).size, 3, `expected all three keys to be used, saw ${seen.join(", ")}`)
	for (const secret of seen) assert.ok(secrets.includes(secret))

	// A retry skips the credential that just failed.
	const failed = await pickChannelKey("c1")
	for (let i = 0; i < 4; i++) {
		const next = await pickChannelKey("c1", [failed.fingerprint])
		assert.notEqual(next.fingerprint, failed.fingerprint)
	}
})

test("a channel with no usable keys fails loudly", async () => {
	await fresh([channelDoc({ _id: "c1" })])
	await assert.rejects(() => pickChannelKey("c1"), /no enabled keys/i)

	// A disabled key does not count as usable.
	const keys = await channelKeys()
	const sealed = await sealSecret("sk-x", config.channelKeyMaster, config.channelKeyVersion)
	await keys.insertOne({
		_id: "k0",
		channelId: "c1",
		cipher: sealed.cipher,
		iv: sealed.iv,
		authTag: sealed.authTag,
		keyVersion: sealed.keyVersion,
		fingerprint: sealed.fingerprint,
		status: "disabled",
		index: 0,
		failCount: 0,
		createdAt: new Date(),
	})
	await assert.rejects(() => pickChannelKey("c1"), /no enabled keys/i)
})
