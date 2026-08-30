process.env.CHANNEL_KEY_MASTER = "unit-test-master-key-0123456789abcdef"
process.env.CHANNEL_KEY_VERSION = "1"
process.env.CHANNEL_AUTO_DISABLE_FAILS = "0"
process.env.KEY_PEPPER = "relay-test-pepper"
process.env.IP_HASH_SECRET = "relay-test-ip-secret"

import test from "node:test"
import assert from "node:assert/strict"

import { config } from "../../lib/config/env.ts"
import { channelKeys, channels, setDb, tokens, usageLogs, users } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import type { ChannelDoc } from "../../lib/db/types.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { sealSecret } from "../../lib/util/crypto.ts"
import { relay } from "../../lib/relay/pipeline.ts"
import type { RelayInput, UpstreamCall } from "../../lib/relay/pipeline.ts"
import type { AuthContext } from "../../lib/auth/authenticate.ts"

const UPSTREAM_SECRET = "sk-upstream-credential"

function channelDoc(type = "openai", baseUrl = "https://api.example.com"): ChannelDoc {
	return {
		_id: "c0",
		name: "c0",
		type: type as ChannelDoc["type"],
		baseUrl,
		status: "enabled",
		priority: 10,
		weight: 0,
		groups: ["default"],
		models: [],
		// The channel calls it something else upstream; the client must never
		// learn that, and must not be billed for it.
		modelMapping: { "gpt-4o": "prod-4o" },
		headers: {},
		autoDisabled: false,
		failCount: 0,
		config: {},
		createdAt: new Date(),
		updatedAt: new Date(),
	}
}

async function fresh(type = "openai"): Promise<void> {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())

	const userCollection = await users()
	await userCollection.insertOne({
		_id: "u1",
		username: "tester",
		displayName: "Tester",
		email: "tester@example.com",
		role: "user",
		status: "enabled",
		group: "default",
		quota: 1_000_000,
		usedQuota: 0,
		requestCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	})

	const tokenCollection = await tokens()
	await tokenCollection.insertOne({
		_id: "t1",
		userId: "u1",
		name: "test key",
		keyPrefix: "sk-testke",
		keyDigest: "digest",
		keyLast4: "1234",
		status: "enabled",
		quota: 1_000_000,
		usedQuota: 0,
		unlimitedQuota: false,
		expiresAt: null,
		allowedIps: [],
		allowedModels: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	})

	const channelCollection = await channels()
	await channelCollection.insertOne(channelDoc(type))

	const sealed = await sealSecret(UPSTREAM_SECRET, config.channelKeyMaster, config.channelKeyVersion)
	const keyCollection = await channelKeys()
	await keyCollection.insertOne({
		_id: "k-c0",
		channelId: "c0",
		cipher: sealed.cipher,
		iv: sealed.iv,
		authTag: sealed.authTag,
		keyVersion: sealed.keyVersion,
		fingerprint: sealed.fingerprint,
		status: "enabled",
		index: 0,
		failCount: 0,
		createdAt: new Date(),
	})
}

function authContext(overrides: Partial<AuthContext["identity"]> = {}): AuthContext {
	return {
		identity: {
			tokenId: "t1",
			tokenName: "test key",
			keyPrefix: "sk-testke",
			keyLast4: "1234",
			userId: "u1",
			username: "tester",
			role: "user",
			group: "default",
			unlimitedQuota: false,
			tokenQuota: 1_000_000,
			userQuota: 1_000_000,
			allowedIps: [],
			allowedModels: [],
			rpmLimit: 600,
			tpmLimit: 0,
			...overrides,
		},
		directives: { flags: [] },
		source: "authorization" as AuthContext["source"],
		clientIp: "203.0.113.9",
		ipHash: "hash-of-203.0.113.9",
		requestId: "req-1",
		startedAt: Date.now(),
	}
}

function clientRequest(): Request {
	return new Request("https://gateway.test/v1/chat/completions", {
		method: "POST",
		headers: {
			// The caller's own gateway credential. It must not be forwarded.
			authorization: "Bearer sk-the-clients-own-key",
			"x-api-key": "sk-also-the-clients",
			cookie: "session=secret",
		},
	})
}

type Captured = { url: string; headers: Headers; body: string }

function jsonUpstream(payload: unknown, status = 200) {
	const calls: Captured[] = []
	const call: UpstreamCall = async (url, init) => {
		calls.push({
			url,
			headers: init.headers as Headers,
			body: String(init.body ?? ""),
		})
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		})
	}
	return { call, calls }
}

function sseUpstream(frames: string[]) {
	const call: UpstreamCall = async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder()
					for (const frame of frames) controller.enqueue(encoder.encode(frame))
					controller.close()
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		)
	return call
}

const completion = {
	id: "chatcmpl-x",
	object: "chat.completion",
	model: "prod-4o",
	choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
	usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
}

function baseInput(overrides: Partial<RelayInput> = {}): RelayInput {
	return {
		req: clientRequest(),
		auth: authContext(),
		endpoint: "chat",
		clientDialect: "openai",
		body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
		model: "gpt-4o",
		stream: false,
		maxAttempts: 1,
		recordBuffered: false,
		...overrides,
	}
}

async function usageRow(requestId = "req-1"): Promise<Record<string, unknown> | null> {
	const collection = await usageLogs()
	return (await collection.findOne({ _id: requestId })) as Record<string, unknown> | null
}

test("a buffered request settles to the blueprint's sanity vector", async () => {
	await fresh()
	const { call, calls } = jsonUpstream(completion)

	const response = await relay(baseInput({ upstream: call }))
	assert.equal(response.status, 200)

	const body = (await response.json()) as Record<string, unknown>
	// GW-013: the client asked for gpt-4o and must be told it got gpt-4o.
	assert.equal(body.model, "gpt-4o")

	// The upstream was addressed with the mapped name.
	assert.equal(JSON.parse(calls[0].body).model, "prod-4o")

	const row = await usageRow()
	assert.equal(row?.status, "success")
	assert.equal(row?.model, "gpt-4o")
	assert.equal(row?.mappedModel, "prod-4o")
	assert.equal(row?.billedModel, "gpt-4o")
	// 1000 prompt + 500 completion on gpt-4o: (1000 + 500*2) * 1.25 = 3750.
	assert.equal(row?.quota, 3750)
	assert.equal(row?.promptTokens, 1000)
	assert.equal(row?.completionTokens, 500)
})

test("the caller's own credential never reaches the provider", async () => {
	await fresh()
	const { call, calls } = jsonUpstream(completion)
	await relay(baseInput({ upstream: call }))

	const sent = calls[0].headers
	assert.equal(sent.get("authorization"), `Bearer ${UPSTREAM_SECRET}`)
	// The client's gateway key and session cookie are dropped, not relayed.
	assert.equal(sent.get("authorization")?.includes("the-clients-own-key"), false)
	assert.equal(sent.get("cookie"), null)
	assert.equal(sent.get("x-api-key"), null)
})

test("an upstream failure releases the reservation and is still recorded", async () => {
	await fresh()
	const { call } = jsonUpstream({ error: { message: "upstream exploded" } }, 500)

	await assert.rejects(relay(baseInput({ upstream: call })))

	const row = await usageRow()
	assert.equal(row?.status, "error")
	assert.equal(row?.quota, 0)
	assert.equal(typeof row?.errorCode, "string")

	// The ledger is intact: a following request still settles normally.
	const ok = jsonUpstream(completion)
	const auth = authContext()
	auth.requestId = "req-2"
	await relay(baseInput({ upstream: ok.call, auth }))
	assert.equal((await usageRow("req-2"))?.quota, 3750)
})

test("a garbled upstream body is refused rather than billed", async () => {
	await fresh()
	const call: UpstreamCall = async () =>
		new Response("<html>gateway timeout</html>", {
			status: 200,
			headers: { "content-type": "text/html" },
		})

	await assert.rejects(relay(baseInput({ upstream: call })), /unparseable|malformed/i)
	assert.equal((await usageRow())?.quota, 0)
})

test("a streamed response settles from the usage frame", async () => {
	await fresh()
	const call = sseUpstream([
		'data: {"id":"c","model":"prod-4o","choices":[{"index":0,"delta":{"content":"he"},"finish_reason":null}]}\n\n',
		'data: {"id":"c","model":"prod-4o","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n',
		'data: {"id":"c","model":"prod-4o","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\n',
		"data: [DONE]\n\n",
	])

	const response = await relay(
		baseInput({ upstream: call, stream: true, usageInjected: true }),
	)
	assert.equal(response.headers.get("content-type")?.includes("text/event-stream"), true)

	const text = await response.text()
	assert.equal(text.includes("[DONE]"), true)
	// The gateway asked for usage, so the client must not receive that frame.
	assert.equal(text.includes('"usage"'), false)
	// GW-013 again, this time on every chunk.
	assert.equal(text.includes("prod-4o"), false)
	assert.equal(text.includes("gpt-4o"), true)

	const row = await usageRow()
	assert.equal(row?.status, "success")
	assert.equal(row?.stream, true)
	assert.equal(row?.quota, 3750)
})

test("an anthropic client streaming over an openai channel gets anthropic frames", async () => {
	await fresh()
	const call = sseUpstream([
		'data: {"id":"c","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
		'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
		"data: [DONE]\n\n",
	])

	const response = await relay(
		baseInput({
			upstream: call,
			stream: true,
			clientDialect: "anthropic",
			body: { model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
		}),
	)

	const text = await response.text()
	assert.equal(text.includes("message_start"), true)
	assert.equal(text.includes("content_block_delta"), true)
	assert.equal(text.includes("message_stop"), true)
	// [DONE] is an OpenAI convention and would confuse an anthropic client.
	assert.equal(text.includes("[DONE]"), false)
})

test("a key may not use a model outside its allowlist", async () => {
	await fresh()
	const { call, calls } = jsonUpstream(completion)
	const auth = authContext({ allowedModels: ["gpt-3.5*"] })

	await assert.rejects(relay(baseInput({ upstream: call, auth })), /may not use model/i)
	// Refused before any cost was incurred.
	assert.equal(calls.length, 0)
})

test("an abandoned stream still settles for what it consumed", async () => {
	await fresh()
	const call = sseUpstream([
		'data: {"id":"c","choices":[{"index":0,"delta":{"content":"one"},"finish_reason":null}]}\n\n',
		'data: {"id":"c","choices":[{"index":0,"delta":{"content":"two"},"finish_reason":null}]}\n\n',
		'data: {"id":"c","choices":[{"index":0,"delta":{"content":"three"},"finish_reason":"stop"}]}\n\n',
		"data: [DONE]\n\n",
	])

	const response = await relay(baseInput({ upstream: call, stream: true }))
	const reader = response.body!.getReader()
	await reader.read()
	// The client goes away mid-stream. Without the cancel path the reservation
	// would simply expire and the request would escape the ledger (GW-009).
	await reader.cancel()

	let row = await usageRow()
	for (let i = 0; i < 50 && !row; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10))
		row = await usageRow()
	}
	assert.equal(row?.status, "aborted")
	assert.equal(row?.stream, true)
})
