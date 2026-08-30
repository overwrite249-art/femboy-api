import test from "node:test"
import assert from "node:assert/strict"

process.env.ALLOW_PLAINTEXT_UPSTREAM = "false"

import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import {
	assertUpstreamUrlAllowed,
	isBlockedAddress,
	looksLikeAddressLiteral,
	setDnsResolver,
} from "../../lib/upstream/ssrf.ts"

function fresh(addresses: string[] = ["93.184.216.34"]) {
	setRedis(new MemoryRedis())
	setDnsResolver(async () => addresses)
}

async function blocked(url: string): Promise<string> {
	try {
		await assertUpstreamUrlAllowed(url)
	} catch (error) {
		return (error as Error).message
	}
	throw new Error(`expected ${url} to be blocked`)
}

test("loopback and private ranges are refused in every notation", async () => {
	fresh()
	for (const url of [
		"https://127.0.0.1/v1",
		"https://10.0.0.5/v1",
		"https://172.16.4.4/v1",
		"https://192.168.1.1/v1",
		"https://169.254.169.254/latest/meta-data/",
		"https://100.100.100.200/latest/meta-data/",
		"https://[::1]/v1",
		"https://[fc00::1]/v1",
		"https://[fe80::1]/v1",
		// IPv4-mapped IPv6 must not launder a loopback address.
		"https://[::ffff:127.0.0.1]/v1",
	]) {
		await blocked(url)
	}
})

test("encoded address literals are refused", async () => {
	fresh()
	// Every one of these reaches 127.0.0.1 and parses cleanly as a URL.
	for (const url of [
		"https://2130706433/v1", // decimal
		"https://0x7f000001/v1", // hex
		"https://0177.0.0.1/v1", // octal
		"https://127.1/v1", // short form
		"https://010.0.0.1/v1", // leading zero
	]) {
		await blocked(url)
	}
})

test("a name that resolves inward is refused", async () => {
	// The name is public, the record is not. Checking the name alone fails here.
	fresh(["169.254.169.254"])
	const message = await blocked("https://totally-legit.example.com/v1")
	assert.match(message, /non-routable/i)

	// A single poisoned address in an otherwise public set still blocks.
	fresh(["93.184.216.34", "10.1.2.3"])
	await blocked("https://mixed.example.com/v1")
})

test("an unresolvable host fails closed", async () => {
	fresh([])
	const message = await blocked("https://nowhere.example.com/v1")
	assert.match(message, /could not be resolved/i)
})

test("internal suffixes and bare service names are refused", async () => {
	fresh()
	for (const url of [
		"https://localhost/v1",
		"https://metadata.google.internal/computeMetadata/v1/",
		"https://redis.local/v1",
		"https://api.svc.lan/v1",
	]) {
		await blocked(url)
	}
})

test("credentials, schemes and ports are constrained", async () => {
	fresh()
	assert.match(await blocked("https://user:pass@api.example.com/v1"), /credentials/i)
	assert.match(await blocked("file:///etc/passwd"), /scheme/i)
	assert.match(await blocked("gopher://api.example.com/"), /scheme/i)
	assert.match(await blocked("http://api.example.com/v1"), /plaintext/i)
	// Redis, Postgres and SSH are the interesting targets on an internal host.
	assert.match(await blocked("https://api.example.com:6379/"), /port/i)
	assert.match(await blocked("https://api.example.com:22/"), /port/i)
})

test("a well-formed public upstream is allowed", async () => {
	fresh(["93.184.216.34"])
	const resolved = await assertUpstreamUrlAllowed("https://api.example.com/v1/chat/completions")
	assert.equal(resolved.hostname, "api.example.com")
	assert.deepEqual(resolved.addresses, ["93.184.216.34"])

	// A public address literal is fine too.
	fresh()
	const literal = await assertUpstreamUrlAllowed("https://93.184.216.34/v1")
	assert.deepEqual(literal.addresses, ["93.184.216.34"])
})

test("the allowlist and denylist are honoured", async () => {
	fresh()
	process.env.UPSTREAM_DOMAIN_DENYLIST = "evil.example.com"
	try {
		assert.match(await blocked("https://evil.example.com/v1"), /denied/i)
		// A denied domain covers its subdomains.
		assert.match(await blocked("https://sub.evil.example.com/v1"), /denied/i)
	} finally {
		delete process.env.UPSTREAM_DOMAIN_DENYLIST
	}

	fresh()
	process.env.UPSTREAM_DOMAIN_ALLOWLIST = "api.openai.com,*.anthropic.com"
	try {
		assert.match(await blocked("https://api.example.com/v1"), /allowlist/i)
		await assertUpstreamUrlAllowed("https://api.openai.com/v1")
		await assertUpstreamUrlAllowed("https://api.anthropic.com/v1")
	} finally {
		delete process.env.UPSTREAM_DOMAIN_ALLOWLIST
	}
})

test("address classification is exact at range edges", () => {
	assert.equal(isBlockedAddress("9.255.255.255"), false)
	assert.equal(isBlockedAddress("10.0.0.0"), true)
	assert.equal(isBlockedAddress("10.255.255.255"), true)
	assert.equal(isBlockedAddress("11.0.0.0"), false)
	assert.equal(isBlockedAddress("172.15.255.255"), false)
	assert.equal(isBlockedAddress("172.16.0.0"), true)
	assert.equal(isBlockedAddress("172.32.0.0"), false)
	assert.equal(isBlockedAddress("8.8.8.8"), false)
	assert.equal(isBlockedAddress("2606:4700::1111"), false)
	// Anything unparseable is treated as hostile.
	assert.equal(isBlockedAddress("not-an-ip"), true)
	assert.equal(isBlockedAddress(""), true)
})

test("address-literal detection does not misfire on hex-looking domains", () => {
	assert.equal(looksLikeAddressLiteral("2130706433"), true)
	assert.equal(looksLikeAddressLiteral("127.0.0.1"), true)
	assert.equal(looksLikeAddressLiteral("::1"), true)
	// These are real domain names made of hex characters.
	assert.equal(looksLikeAddressLiteral("abc.def"), false)
	assert.equal(looksLikeAddressLiteral("cafe.babe"), false)
	assert.equal(looksLikeAddressLiteral("api.example.com"), false)
})
