import test from "node:test"
import assert from "node:assert/strict"

process.env.DEFAULT_RPM = "60"
process.env.DEFAULT_IP_RPM = "120"
process.env.DEFAULT_SUCCESS_PER_WINDOW = "3"
process.env.DEFAULT_WINDOW_SEC = "60"
process.env.IP_HASH_SECRET = "unit-test-ip-salt-00000000000000000000000"

import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import {
	acquireConcurrency,
	enforceRequestLimits,
	enforceSuccessWindow,
	enforceTokenBudget,
} from "../../lib/ratelimit/index.ts"
import type { Identity } from "../../lib/auth/authenticate.ts"

function identity(overrides: Partial<Identity> = {}): Identity {
	return {
		tokenId: "t1",
		tokenName: "primary",
		keyPrefix: "abcd1234",
		keyLast4: "wxyz",
		userId: "u1",
		username: "kit",
		role: "user",
		group: "default",
		unlimitedQuota: true,
		tokenQuota: 0,
		userQuota: 1_000_000,
		allowedIps: [],
		allowedModels: [],
		rpmLimit: 5,
		tpmLimit: 0,
		...overrides,
	}
}

function fresh() {
	setRedis(new MemoryRedis())
}

test("the per-key bucket is a hard ceiling", async () => {
	fresh()
	const who = identity({ rpmLimit: 5 })
	for (let i = 0; i < 5; i++) {
		await enforceRequestLimits(who, "iphash-a")
	}
	await assert.rejects(() => enforceRequestLimits(who, "iphash-a"), /rate limit/i)
})

test("buckets are independent per key", async () => {
	fresh()
	const a = identity({ tokenId: "key-a", rpmLimit: 2 })
	const b = identity({ tokenId: "key-b", rpmLimit: 2 })
	await enforceRequestLimits(a, "iphash-a")
	await enforceRequestLimits(a, "iphash-a")
	await assert.rejects(() => enforceRequestLimits(a, "iphash-a"))
	// A different key must be unaffected by its neighbour's exhaustion.
	await enforceRequestLimits(b, "iphash-b")
	await enforceRequestLimits(b, "iphash-b")
})

test("the per-address bucket binds even when the key is generous", async () => {
	fresh()
	process.env.DEFAULT_IP_RPM = "3"
	try {
		// Generous key and account limits, so only the address bucket can trip.
		const who = identity({ tokenId: "roomy", rpmLimit: 1000 })
		await enforceRequestLimits(who, "shared-address")
		await enforceRequestLimits(who, "shared-address")
		await enforceRequestLimits(who, "shared-address")
		await assert.rejects(() => enforceRequestLimits(who, "shared-address"), /address/i)
	} finally {
		process.env.DEFAULT_IP_RPM = "120"
	}
})

test("an unknown address skips the address bucket rather than sharing one", async () => {
	fresh()
	process.env.DEFAULT_IP_RPM = "1"
	try {
		const who = identity({ tokenId: "anon", rpmLimit: 1000 })
		// Two requests with no resolvable address must not collide in one bucket.
		await enforceRequestLimits(who, "")
		await enforceRequestLimits(who, "")
	} finally {
		process.env.DEFAULT_IP_RPM = "120"
	}
})

test("the token budget window bounds consumption", async () => {
	fresh()
	const who = identity({ userId: "tpm-user", tpmLimit: 100 })
	await enforceTokenBudget(who, 60)
	await assert.rejects(() => enforceTokenBudget(who, 60), /token rate limit/i)
})

test("a zero token budget means unlimited", async () => {
	fresh()
	const who = identity({ userId: "tpm-off", tpmLimit: 0 })
	await enforceTokenBudget(who, 1_000_000)
})

test("the success window damps sustained abuse", async () => {
	fresh()
	const who = identity({ userId: "succ-user" })
	await enforceSuccessWindow(who, "r1")
	await enforceSuccessWindow(who, "r2")
	await enforceSuccessWindow(who, "r3")
	await assert.rejects(() => enforceSuccessWindow(who, "r4"), /successful requests/i)
})

test("concurrency leases are bounded and returned", async () => {
	fresh()
	const first = await acquireConcurrency("user", "conc-user", 2)
	const second = await acquireConcurrency("user", "conc-user", 2)
	await assert.rejects(() => acquireConcurrency("user", "conc-user", 2), /concurrent/i)

	await first.release()
	const third = await acquireConcurrency("user", "conc-user", 2)

	// Releasing twice must not free a slot that was never held.
	await first.release()
	await assert.rejects(() => acquireConcurrency("user", "conc-user", 2), /concurrent/i)

	await second.release()
	await third.release()
})

test("a zero concurrency limit disables the gate", async () => {
	fresh()
	const lease = await acquireConcurrency("user", "no-gate", 0)
	await lease.release()
})
