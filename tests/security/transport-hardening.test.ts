import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { setDnsResolver, assertUpstreamUrlAllowed, isBlockedAddress } from "../../lib/upstream/ssrf.ts"
import { upstreamFetch, guardStream } from "../../lib/upstream/fetch.ts"
import { safeJsonParse, JsonLimitError, readLimitedText } from "../../lib/util/json.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { createPinnedDispatcher, pinnedLookup } from "../../lib/upstream/dispatcher.ts"

const originalFetch = globalThis.fetch
const environment = { ...process.env }

beforeEach(() => {
	setRedis(new MemoryRedis())
	setDnsResolver(async () => ["8.8.8.8"])
	Object.assign(process.env, { NODE_ENV: "test" })
	delete process.env.UPSTREAM_DOMAIN_DENYLIST
	delete process.env.UPSTREAM_DOMAIN_ALLOWLIST
})
afterEach(() => {
	globalThis.fetch = originalFetch
	setDnsResolver(null)
	for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
	Object.assign(process.env, environment)
})

test("authenticated redirects cannot forward credentials to a different public origin", async () => {
	const calls: string[] = []
	globalThis.fetch = async (url) => {
		calls.push(String(url))
		return calls.length === 1
			? new Response(null, { status: 307, headers: { location: "https://other.example/collect" } })
			: Response.json({ ok: true })
	}
	await assert.rejects(upstreamFetch("https://provider.example/v1/chat", {
		method: "POST",
		headers: { authorization: "Bearer opaque-provider-fixture" },
		body: JSON.stringify({ prompt: "private fixture" }),
	}), /origin|redirect/i)
	assert.equal(calls.length, 1)
})

test("a same-origin 303 changes POST to GET and drops body headers", async () => {
	const calls: RequestInit[] = []
	globalThis.fetch = async (_url, init) => {
		calls.push(init!)
		return calls.length === 1
			? new Response(null, { status: 303, headers: { location: "/result" } })
			: Response.json({ ok: true })
	}
	const response = await upstreamFetch("https://provider.example/submit", {
		method: "POST",
		headers: { "content-type": "application/json", "content-length": "2" },
		body: "{}",
	})
	await response.text()
	assert.equal(calls[1].method, "GET")
	assert.equal(calls[1].body, undefined)
	assert.equal(new Headers(calls[1].headers).has("content-length"), false)
})

test("a validated hostname is pinned to the checked DNS answer at connect time", async () => {
	let dispatcher: unknown
	globalThis.fetch = async (_url, init) => {
		dispatcher = (init as RequestInit & { dispatcher?: unknown })?.dispatcher
		return Response.json({ ok: true })
	}
	await (await upstreamFetch("https://provider.example/v1/models")).text()
	assert.ok(dispatcher, "the actual connection must not perform a second unvalidated DNS lookup")
})

test("socket lookup returns only validated addresses for the original hostname and family", async () => {
	const lookup = pinnedLookup({
		url: new URL("https://provider.example"), hostname: "provider.example",
		addresses: ["8.8.8.8", "2001:4860:4860::8888"],
	})
	const resolve = (name: string, options: { family?: number; all?: boolean }) => new Promise<unknown>((resolve, reject) => {
		lookup(name, options, (error, address) => error ? reject(error) : resolve(address))
	})
	assert.equal(await resolve("provider.example", { family: 4 }), "8.8.8.8")
	assert.deepEqual(await resolve("provider.example", { all: true }), [
		{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 },
	])
	await assert.rejects(resolve("unvalidated.example", { family: 4 }), /validated/)
})

test("native fetch and the pinned dispatcher interoperate over a real socket", async () => {
	const server = createServer((req, res) => res.end(req.headers.host))
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const port = (server.address() as AddressInfo).port
	// Manually injected local fixture for the adapter; URL policy still rejects
	// private upstreams. This hostname must not require a second public lookup.
	const target = {
		url: new URL(`http://socket-fixture.invalid:${port}`),
		hostname: "socket-fixture.invalid", addresses: ["127.0.0.1"],
	}
	const dispatcher = createPinnedDispatcher(target)
	try {
		const response = await originalFetch(target.url, { dispatcher } as RequestInit)
		assert.equal(await response.text(), `socket-fixture.invalid:${port}`)
	} finally {
		await dispatcher.close()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})

test("denied domain names remain denied with a DNS trailing dot", async () => {
	process.env.UPSTREAM_DOMAIN_DENYLIST = "provider.example"
	await assert.rejects(assertUpstreamUrlAllowed("https://provider.example./v1/models"), /denied/)
})

test("plaintext upstreams are refused in production even when opted in", async () => {
	Object.assign(process.env, { NODE_ENV: "production" })
	process.env.ALLOW_PLAINTEXT_UPSTREAM = "true"
	process.env.UPSTREAM_ALLOWED_PORTS = "80,443"
	await assert.rejects(assertUpstreamUrlAllowed("http://provider.example/v1/models"), /plaintext/)
})

test("IPv6 transition, local-use NAT64, site-local and documentation ranges are blocked", () => {
	for (const ip of ["::10.0.0.1", "64:ff9b:1::a00:1", "fec0::1", "2001::1", "3fff::1"]) {
		assert.equal(isBlockedAddress(ip), true, ip)
	}
	assert.equal(isBlockedAddress("2001:4860:4860::8888"), false)
})

test("DNS lookup cannot succeed with only half the address families checked", async () => {
	setDnsResolver(null)
	globalThis.fetch = async (url) => {
		if (String(url).includes("type=AAAA")) throw new Error("resolver unavailable")
		return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] })
	}
	await assert.rejects(assertUpstreamUrlAllowed("https://provider.example"), /resolve/)
})

test("deep JSON is rejected by the depth bound rather than overflowing the reviver stack", () => {
	const bomb = "[".repeat(20_000) + "0" + "]".repeat(20_000)
	assert.throws(() => safeJsonParse(bomb), JsonLimitError)
})

test("JSON byte limits count UTF-8 bytes, not UTF-16 characters", () => {
	assert.throws(() => safeJsonParse('"猫猫"', { maxBytes: 5 }), JsonLimitError)
})

test("rejecting an oversized upload cancels its source", async () => {
	let canceled = false
	const source = new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new Uint8Array(10)) },
		cancel() { canceled = true },
	})
	await assert.rejects(readLimitedText(source, 1), JsonLimitError)
	assert.equal(canceled, true)
})

test("a hostile cancellation hook cannot delay a stream timeout indefinitely", async () => {
	const source = new ReadableStream<Uint8Array>({
		pull() { return new Promise(() => {}) },
		cancel() { return new Promise(() => {}) },
	})
	const reader = guardStream(source, { maxBytes: 1024, idleMs: 10 }).getReader()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const outcome = await Promise.race([
			reader.read().then(() => "resolved", () => "rejected"),
			new Promise<string>((resolve) => { timer = setTimeout(() => resolve("hung"), 200) }),
		])
		assert.equal(outcome, "rejected")
	} finally {
		clearTimeout(timer)
	}
})