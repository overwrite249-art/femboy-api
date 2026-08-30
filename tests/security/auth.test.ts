import test from "node:test"
import assert from "node:assert/strict"

// Set before any getter runs. `config` reads process.env lazily, so assigning
// here - after the import hoisting - is still in time.
process.env.KEY_PEPPER = "unit-test-pepper-000000000000000000000000"
process.env.IP_HASH_SECRET = "unit-test-ip-salt-00000000000000000000000"
process.env.MIN_AUTH_LATENCY_MS = "25"
process.env.TRUSTED_PROXY_HOPS = "1"

import { setDb, tokens, users } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import {
	assertModelAllowed,
	authenticate,
	effectiveDirectives,
	invalidateTokenCache,
} from "../../lib/auth/authenticate.ts"
import { generateApiKey, parseApiKey } from "../../lib/auth/keys.ts"
import { cidrContains, ipToBytes } from "../../lib/auth/cidr.ts"
import type { EntityStatus } from "../../lib/db/types.ts"

const FLOOR_MS = 25

type SeedOptions = {
	tokenStatus?: EntityStatus
	userStatus?: EntityStatus
	expiresAt?: Date | null
	allowedIps?: string[]
	allowedModels?: string[]
}

async function seed(options: SeedOptions = {}) {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	const generated = await generateApiKey()
	const now = new Date()

	const userCollection = await users()
	await userCollection.insertOne({
		_id: "u1",
		username: "kit",
		displayName: "Kit",
		email: "kit@example.test",
		role: "user",
		status: options.userStatus ?? "enabled",
		group: "default",
		quota: 1_000_000,
		usedQuota: 0,
		requestCount: 0,
		createdAt: now,
		updatedAt: now,
	})

	const tokenCollection = await tokens()
	await tokenCollection.insertOne({
		_id: "t1",
		userId: "u1",
		name: "primary",
		keyPrefix: generated.prefix,
		keyDigest: generated.digest,
		keyLast4: generated.last4,
		status: options.tokenStatus ?? "enabled",
		quota: 0,
		usedQuota: 0,
		unlimitedQuota: true,
		expiresAt: options.expiresAt ?? null,
		allowedIps: options.allowedIps ?? [],
		allowedModels: options.allowedModels ?? [],
		createdAt: now,
		updatedAt: now,
	})

	return generated
}

type Dialect = "bearer" | "anthropic" | "google" | "azure" | "midjourney" | "websocket" | "query"

function request(key: string, dialect: Dialect = "bearer", ip = "203.0.113.7"): Request {
	const headers = new Headers()
	headers.set("x-forwarded-for", ip)
	let url = "https://gateway.test/v1/chat/completions"
	switch (dialect) {
		case "bearer":
			headers.set("authorization", `Bearer ${key}`)
			break
		case "anthropic":
			headers.set("x-api-key", key)
			break
		case "google":
			headers.set("x-goog-api-key", key)
			break
		case "azure":
			headers.set("api-key", key)
			break
		case "midjourney":
			headers.set("mj-api-secret", key)
			break
		case "websocket":
			headers.set(
				"sec-websocket-protocol",
				`realtime, openai-insecure-api-key.${key}, openai-beta.realtime-v1`,
			)
			break
		case "query":
			url =
				"https://gateway.test/v1beta/models/gemini-2.0-flash:generateContent?key=" +
				encodeURIComponent(key)
			break
	}
	return new Request(url, { method: "POST", headers })
}

test("cidr matching handles both families and rejects sloppy input", () => {
	assert.ok(cidrContains("10.0.0.0/8", "10.1.2.3"))
	assert.ok(!cidrContains("10.0.0.0/8", "11.1.2.3"))
	assert.ok(cidrContains("203.0.113.7/32", "203.0.113.7"))
	assert.ok(cidrContains("192.168.1.0/24", "192.168.1.255"))
	assert.ok(!cidrContains("192.168.1.0/24", "192.168.2.1"))
	assert.ok(cidrContains("2001:db8::/32", "2001:db8:1234::1"))
	assert.ok(!cidrContains("2001:db8::/32", "2001:dba::1"))
	// An IPv4-mapped address must satisfy an IPv4 rule.
	assert.ok(cidrContains("127.0.0.0/8", "::ffff:127.0.0.1"))
	// Families never cross-match.
	assert.ok(!cidrContains("10.0.0.0/8", "::1"))
	// Leading zeros are octal in some parsers; we refuse them outright.
	assert.equal(ipToBytes("010.0.0.1"), null)
	assert.equal(ipToBytes("1.2.3.4.5"), null)
	assert.equal(ipToBytes("2001:db8::1::2"), null)
})

test("key parsing is strict and extracts directives", () => {
	const prefix = "abcd1234"
	const secret = "z".repeat(48)
	const parsed = parseApiKey(`sk-${prefix}${secret}-ch-42-nostream-group-team`)
	assert.ok(parsed)
	assert.equal(parsed.prefix, prefix)
	assert.equal(parsed.secret, secret)
	assert.equal(parsed.directives.channelId, "42")
	assert.equal(parsed.directives.group, "team")
	assert.deepEqual(parsed.directives.flags, ["nostream"])

	assert.equal(parseApiKey(""), null)
	assert.equal(parseApiKey("sk-short"), null)
	assert.equal(parseApiKey(`pk-${prefix}${secret}`), null)
	assert.equal(parseApiKey(`sk-${prefix}${"!".repeat(48)}`), null)
	assert.equal(parseApiKey(`sk-${"a".repeat(600)}`), null)
})

test("a valid key authenticates through every provider dialect", async () => {
	const generated = await seed()
	const dialects: Dialect[] = [
		"bearer",
		"anthropic",
		"google",
		"azure",
		"midjourney",
		"websocket",
		"query",
	]
	for (const dialect of dialects) {
		const req = request(generated.key, dialect)
		// Guard against a helper that silently builds the wrong request.
		if (dialect === "query") {
			assert.equal(new URL(req.url).searchParams.get("key"), generated.key)
			assert.equal(req.headers.get("authorization"), null)
		}
		const context = await authenticate(req)
		assert.equal(context.identity.userId, "u1", `${dialect} should authenticate`)
		assert.equal(context.identity.tokenId, "t1")
		assert.equal(context.identity.group, "default")
		assert.equal(context.identity.keyPrefix, generated.prefix)
		assert.equal(context.source === "none", false)
		assert.match(context.requestId, /^[0-9a-f]{32}$/)
		// The credential must never survive into the context.
		assert.ok(!JSON.stringify(context).includes(generated.secret))
	}
})

test("an unknown prefix and a wrong secret are indistinguishable and slow", async () => {
	const generated = await seed()

	const wrongSecret = `sk-${generated.prefix}${"q".repeat(48)}`
	const unknownPrefix = `sk-zzzzzzzz${generated.secret}`

	const startWrong = Date.now()
	await assert.rejects(() => authenticate(request(wrongSecret)))
	const wrongElapsed = Date.now() - startWrong

	const startUnknown = Date.now()
	await assert.rejects(() => authenticate(request(unknownPrefix)))
	const unknownElapsed = Date.now() - startUnknown

	assert.ok(wrongElapsed >= FLOOR_MS - 2, `wrong secret returned in ${wrongElapsed}ms`)
	assert.ok(unknownElapsed >= FLOOR_MS - 2, `unknown prefix returned in ${unknownElapsed}ms`)

	// A malformed credential must also pay the floor.
	const startJunk = Date.now()
	await assert.rejects(() => authenticate(request("not-a-key")))
	assert.ok(Date.now() - startJunk >= FLOOR_MS - 2)
})

test("disabled and expired credentials are refused", async () => {
	const disabled = await seed({ tokenStatus: "disabled" })
	await assert.rejects(() => authenticate(request(disabled.key)))

	const expired = await seed({ expiresAt: new Date(Date.now() - 1000) })
	await assert.rejects(() => authenticate(request(expired.key)))

	const suspended = await seed({ userStatus: "disabled" })
	await assert.rejects(() => authenticate(request(suspended.key)))
})

test("a console session token cannot authenticate the relay", async () => {
	await seed()
	await assert.rejects(() =>
		authenticate(request("sess-abcdef0123456789abcdef0123456789abcdef0123456789")),
	)
})

test("the ip allowlist is enforced and fails closed", async () => {
	const generated = await seed({ allowedIps: ["203.0.113.0/24"] })
	const allowed = await authenticate(request(generated.key, "bearer", "203.0.113.99"))
	assert.equal(allowed.identity.userId, "u1")
	await assert.rejects(() => authenticate(request(generated.key, "bearer", "198.51.100.4")))

	// No usable address at all must be refused, not waved through.
	const headers = new Headers()
	headers.set("authorization", `Bearer ${generated.key}`)
	await assert.rejects(() =>
		authenticate(
			new Request("https://gateway.test/v1/chat/completions", { method: "POST", headers }),
		),
	)
})

test("the client address is read from the right of x-forwarded-for", async () => {
	const generated = await seed({ allowedIps: ["203.0.113.0/24"] })
	// A client that prepends a forged entry must not be able to choose its own
	// apparent address: with one trusted hop the real client is the last entry.
	const forged = await authenticate(request(generated.key, "bearer", "10.0.0.1, 203.0.113.5"))
	assert.equal(forged.identity.userId, "u1")
	await assert.rejects(() =>
		authenticate(request(generated.key, "bearer", "203.0.113.5, 198.51.100.9")),
	)
})

test("the model allowlist honours a single trailing wildcard", async () => {
	const generated = await seed({ allowedModels: ["gpt-4o", "claude-3-*"] })
	const context = await authenticate(request(generated.key))
	assert.doesNotThrow(() => assertModelAllowed(context.identity, "gpt-4o"))
	assert.doesNotThrow(() => assertModelAllowed(context.identity, "claude-3-opus"))
	assert.throws(() => assertModelAllowed(context.identity, "gpt-4o-mini"))
	assert.throws(() => assertModelAllowed(context.identity, "gemini-2.0-flash"))
})

test("a channel pin is dropped for ordinary users", async () => {
	const generated = await seed()
	const context = await authenticate(request(`${generated.key}-ch-7`))
	assert.equal(context.directives.channelId, "7")
	assert.equal(effectiveDirectives(context).channelId, undefined)
})

test("revocation takes effect once the identity cache is invalidated", async () => {
	const generated = await seed()
	assert.equal((await authenticate(request(generated.key))).identity.userId, "u1")

	const tokenCollection = await tokens()
	await tokenCollection.updateOne({ _id: "t1" }, { $set: { status: "disabled" } })

	// Still cached, so still accepted - this is the documented staleness window.
	assert.equal((await authenticate(request(generated.key))).identity.userId, "u1")

	await invalidateTokenCache(generated.prefix)
	await assert.rejects(() => authenticate(request(generated.key)))
})
