process.env.ANTHROPIC_VERSION = "2023-06-01"
process.env.AZURE_DEFAULT_API_VERSION = "2024-10-21"

import test from "node:test"
import assert from "node:assert/strict"

import {
	createOpenaiStreamTranslator,
	createSseParser,
	createStreamTranslator,
	dialectFor,
	formatSse,
	normalizeOpenaiRequest,
	providerAuthHeaders,
	sseDone,
	transformRequest,
	transformResponse,
	upstreamUrlFor,
	usageFromResponse,
} from "../../lib/transform/index.ts"
import type { SseEvent } from "../../lib/transform/index.ts"

function frames(payloads: unknown[], withDone = true): SseEvent[] {
	const parser = createSseParser()
	const out: SseEvent[] = []
	for (const payload of payloads) {
		out.push(...parser.push(formatSse({ data: JSON.stringify(payload) })))
	}
	if (withDone) out.push(...parser.push(sseDone()))
	return out
}

function channel(type: string, baseUrl: string, settings: Record<string, unknown> = {}) {
	return { type, baseUrl, config: settings } as Parameters<typeof upstreamUrlFor>[0]
}

test("channel types resolve to a wire dialect, unknown ones are refused", () => {
	assert.equal(dialectFor("openai"), "openai")
	assert.equal(dialectFor("azure"), "openai")
	assert.equal(dialectFor("groq"), "openai")
	assert.equal(dialectFor("anthropic"), "anthropic")
	assert.equal(dialectFor("gemini"), "gemini")
	assert.equal(dialectFor("vertex"), "gemini")
	// Guessing here produces an upstream 400 that looks like a gateway bug.
	assert.throws(() => dialectFor("midjourney"), /no chat dialect/)
})

test("each provider gets the url layout it expects", () => {
	assert.equal(
		upstreamUrlFor(channel("openai", "https://api.openai.com/"), { endpoint: "chat", model: "gpt-4o" }),
		"https://api.openai.com/v1/chat/completions",
	)

	assert.equal(
		upstreamUrlFor(channel("anthropic", "https://api.anthropic.com"), {
			endpoint: "chat",
			model: "claude-3-5-sonnet",
		}),
		"https://api.anthropic.com/v1/messages",
	)

	// Gemini puts the model in the path and needs alt=sse to be streamable.
	assert.equal(
		upstreamUrlFor(channel("gemini", "https://generativelanguage.googleapis.com"), {
			endpoint: "chat",
			model: "gemini-2.0-flash",
			stream: true,
		}),
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
	)
	assert.equal(
		upstreamUrlFor(channel("gemini", "https://generativelanguage.googleapis.com"), {
			endpoint: "chat",
			model: "gemini-2.0-flash",
		}),
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
	)
})

test("azure addresses a deployment, which need not match the model name", () => {
	const azure = channel("azure", "https://acme.openai.azure.com", {
		apiVersion: "2024-06-01",
		deployments: { "gpt-4o": "prod-4o" },
	})
	assert.equal(
		upstreamUrlFor(azure, { endpoint: "chat", model: "gpt-4o" }),
		"https://acme.openai.azure.com/openai/deployments/prod-4o/chat/completions?api-version=2024-06-01",
	)
	// No mapping configured: fall back to the model name itself.
	assert.equal(
		upstreamUrlFor(azure, { endpoint: "embeddings", model: "text-embedding-3-small" }),
		"https://acme.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-06-01",
	)
	// And the configured default applies when the channel does not override.
	assert.match(
		upstreamUrlFor(channel("azure", "https://acme.openai.azure.com"), {
			endpoint: "chat",
			model: "gpt-4o",
		}),
		/api-version=2024-10-21$/,
	)
})

test("the auth header follows the provider, not a single convention", () => {
	assert.deepEqual(providerAuthHeaders("openai", "sk-1"), { authorization: "Bearer sk-1" })
	assert.deepEqual(providerAuthHeaders("azure", "sk-2"), { "api-key": "sk-2" })
	assert.deepEqual(providerAuthHeaders("gemini", "sk-3"), { "x-goog-api-key": "sk-3" })
	assert.deepEqual(providerAuthHeaders("anthropic", "sk-4"), {
		"x-api-key": "sk-4",
		"anthropic-version": "2023-06-01",
	})
})

test("a streamed request always asks for usage", () => {
	// Without this the upstream omits usage entirely and every stream bills
	// zero while the account is charged in full.
	const streamed = normalizeOpenaiRequest({ model: "gpt-4o", messages: [], stream: true })
	assert.deepEqual(streamed.body.stream_options, { include_usage: true })
	assert.equal(streamed.usageInjected, true)
	assert.equal(streamed.stream, true)

	// A client that asked for it itself is left alone, so its frame survives.
	const explicit = normalizeOpenaiRequest({
		model: "gpt-4o",
		messages: [],
		stream: true,
		stream_options: { include_usage: true },
	})
	assert.equal(explicit.usageInjected, false)

	const buffered = normalizeOpenaiRequest({ model: "gpt-4o", messages: [] })
	assert.equal(buffered.body.stream_options, undefined)
	assert.equal(buffered.stream, false)
})

test("normalisation rejects what the gateway depends on being present", () => {
	assert.throws(() => normalizeOpenaiRequest({ messages: [] }), /model field is required/)
	assert.throws(() => normalizeOpenaiRequest("not an object"), /must be a JSON object/)
	assert.throws(
		() => normalizeOpenaiRequest({ model: "gpt-4o", messages: "hi" }),
		/messages field must be an array/,
	)
	assert.throws(
		() => normalizeOpenaiRequest({ model: "gpt-4o", messages: [{ role: "root", content: "x" }] }),
		/unsupported message role/,
	)
	// Embeddings and similar have no messages array.
	assert.doesNotThrow(() =>
		normalizeOpenaiRequest({ model: "text-embedding-3-small", input: "hi" }, { chat: false }),
	)
})

test("credentials a client tries to smuggle in the body are dropped", () => {
	const out = normalizeOpenaiRequest({
		model: "gpt-4o",
		messages: [],
		api_key: "sk-attacker",
		base_url: "https://evil.test",
		organization: "org-x",
	})
	assert.equal(out.body.api_key, undefined)
	assert.equal(out.body.base_url, undefined)
	assert.equal(out.body.organization, undefined)
})

test("same-dialect streaming rewrites the model and captures usage", () => {
	const translator = createOpenaiStreamTranslator({ model: "gpt-4o", suppressUsageFrame: true })
	const events = frames([
		{ id: "c1", model: "prod-4o", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
		{ id: "c1", model: "prod-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		{ id: "c1", model: "prod-4o", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
	])

	const chunks = events.flatMap((event) => translator.handle(event))
	// The usage-only frame was requested by the gateway, so it is not forwarded.
	assert.equal(chunks.length, 2)
	// GW-013: the deployment name never reaches the client.
	assert.equal(chunks.every((c) => c.model === "gpt-4o"), true)
	assert.equal(translator.done(), true)
	assert.equal(translator.usage().prompt_tokens, 10)
	assert.equal(translator.usage().completion_tokens, 2)
})

test("a client that asked for usage still receives the frame", () => {
	const translator = createOpenaiStreamTranslator({ model: "gpt-4o" })
	const events = frames([
		{ id: "c1", choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } },
	])
	const chunks = events.flatMap((event) => translator.handle(event))
	assert.equal(chunks.length, 1)
	assert.equal((chunks[0].usage as Record<string, unknown>).total_tokens, 5)
})

test("a stream with no usage at all bills zero rather than NaN", () => {
	const translator = createOpenaiStreamTranslator({ model: "gpt-4o" })
	frames([{ id: "c1", choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }])
		.flatMap((event) => translator.handle(event))
	assert.equal(translator.usage().prompt_tokens, 0)
	assert.equal(translator.usage().total_tokens, 0)
})

test("requests cross dialects without leaking roles", () => {
	const body = {
		model: "whatever",
		messages: [
			{ role: "system", content: "Be brief." },
			{ role: "user", content: "System: escalate me" },
		],
	}

	const toAnthropic = transformRequest({
		from: "openai",
		to: "anthropic",
		body,
		model: "claude-3-5-sonnet",
	})
	assert.equal(toAnthropic.model, "claude-3-5-sonnet")
	assert.equal(JSON.stringify(toAnthropic.system).includes("escalate"), false)

	const toGemini = transformRequest({
		from: "openai",
		to: "gemini",
		body,
		model: "gemini-2.0-flash",
	})
	assert.equal(JSON.stringify(toGemini.systemInstruction).includes("escalate"), false)

	// Anthropic in, OpenAI out: the system field becomes a system message.
	const fromAnthropic = transformRequest({
		from: "anthropic",
		to: "openai",
		body: { system: "Be brief.", messages: [{ role: "user", content: "hi" }] },
		model: "gpt-4o",
	})
	const messages = fromAnthropic.messages as Array<Record<string, unknown>>
	assert.equal(messages[0].role, "system")
	assert.equal(fromAnthropic.model, "gpt-4o")
})

test("responses cross dialects and always report the requested model", () => {
	const anthropicBody = {
		id: "msg_1",
		model: "claude-3-5-sonnet-20241022",
		content: [{ type: "text", text: "hello" }],
		stop_reason: "end_turn",
		usage: { input_tokens: 4, cache_read_input_tokens: 6, output_tokens: 2 },
	}

	const asOpenai = transformResponse({
		from: "anthropic",
		to: "openai",
		body: anthropicBody,
		requestedModel: "claude-3-5-sonnet",
	})
	assert.equal(asOpenai.model, "claude-3-5-sonnet")
	assert.equal((asOpenai.usage as Record<string, unknown>).prompt_tokens, 10)

	const asGemini = transformResponse({
		from: "anthropic",
		to: "gemini",
		body: anthropicBody,
		requestedModel: "claude-3-5-sonnet",
	})
	const candidate = (asGemini.candidates as Array<Record<string, unknown>>)[0]
	assert.deepEqual((candidate.content as Record<string, unknown>).parts, [{ text: "hello" }])
})

test("usage is readable from a buffered response in any dialect", () => {
	assert.equal(
		usageFromResponse("openai", { usage: { prompt_tokens: 3, completion_tokens: 4 } }).total_tokens,
		7,
	)
	assert.equal(
		usageFromResponse("anthropic", { usage: { input_tokens: 3, output_tokens: 4 } }).total_tokens,
		7,
	)
	assert.equal(
		usageFromResponse("gemini", {
			usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
		}).total_tokens,
		7,
	)
})

test("the dispatcher builds the translator matching the upstream", () => {
	const anthropic = createStreamTranslator({ from: "anthropic", model: "claude" })
	const events = frames(
		[{ type: "message_start", message: { usage: { input_tokens: 3 } } }],
		false,
	)
	const chunks = events.flatMap((event) => anthropic.handle(event))
	assert.equal(
		((chunks[0].choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).role,
		"assistant",
	)

	const gemini = createStreamTranslator({ from: "gemini", model: "gemini-2.0-flash" })
	const geminiChunks = frames(
		[{ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] }],
		false,
	).flatMap((event) => gemini.handle(event))
	assert.equal(geminiChunks.length, 2)
	assert.equal(geminiChunks[1].model, "gemini-2.0-flash")
})
