import test from "node:test"
import assert from "node:assert/strict"

import { createClientFramer } from "../../lib/transform/framing.ts"
import { createSseParser, parseSseData } from "../../lib/transform/sse.ts"
import type { SseEvent } from "../../lib/transform/sse.ts"

function chunkOf(delta: Record<string, unknown>, finishReason: string | null = null) {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		model: "m",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	}
}

function parse(wire: string): SseEvent[] {
	const parser = createSseParser()
	return [...parser.push(wire), ...parser.flush()]
}

test("openai framing ends with the done sentinel", () => {
	const framer = createClientFramer("openai", { model: "gpt-4o" })
	const wire = framer.start() + framer.chunk(chunkOf({ content: "hi" })) + framer.finish()
	const events = parse(wire)
	assert.equal(events.length, 2)
	assert.equal(events[1].data, "[DONE]")
	const first = parseSseData<Record<string, unknown>>(events[0].data)
	assert.equal((first?.choices as Array<Record<string, unknown>>)[0].index, 0)
})

test("gemini framing never sends a done sentinel", () => {
	// [DONE] is not valid JSON and would be a parse error for a gemini client.
	const framer = createClientFramer("gemini", { model: "gemini-2.0-flash" })
	const wire =
		framer.start() +
		framer.chunk(chunkOf({ content: "hi" })) +
		framer.chunk(chunkOf({}, "stop")) +
		framer.finish({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })

	const events = parse(wire)
	assert.equal(
		events.some((e) => e.data.trim() === "[DONE]"),
		false,
	)

	const payloads = events.map((e) => parseSseData<Record<string, unknown>>(e.data))
	const candidate = (payloads[0]?.candidates as Array<Record<string, unknown>>)[0]
	assert.deepEqual((candidate.content as Record<string, unknown>).parts, [{ text: "hi" }])

	const finished = (payloads[1]?.candidates as Array<Record<string, unknown>>)[0]
	assert.equal(finished.finishReason, "STOP")

	// Usage arrives in the trailing frame; the finish reason is not repeated.
	const last = payloads[payloads.length - 1]
	assert.equal(last?.candidates, undefined)
	assert.equal((last?.usageMetadata as Record<string, unknown>).promptTokenCount, 3)
})

test("anthropic framing opens and closes every block", () => {
	const framer = createClientFramer("anthropic", { model: "claude-3-5-sonnet", id: "msg_test" })
	const wire =
		framer.start() +
		framer.chunk(chunkOf({ content: "Hel" })) +
		framer.chunk(chunkOf({ content: "lo" })) +
		framer.chunk(chunkOf({}, "stop")) +
		framer.finish({ completion_tokens: 2 })

	const names = parse(wire).map((e) => e.event)
	assert.deepEqual(names, [
		"message_start",
		"content_block_start",
		"content_block_delta",
		"content_block_delta",
		"content_block_stop",
		"message_delta",
		"message_stop",
	])

	const events = parse(wire)
	const start = parseSseData<Record<string, unknown>>(events[0].data)
	assert.equal((start?.message as Record<string, unknown>).id, "msg_test")

	const messageDelta = parseSseData<Record<string, unknown>>(events[5].data)
	assert.equal((messageDelta?.delta as Record<string, unknown>).stop_reason, "end_turn")
	assert.equal((messageDelta?.usage as Record<string, unknown>).output_tokens, 2)
})

test("anthropic tool calls become their own blocks after the text block", () => {
	const framer = createClientFramer("anthropic", { model: "claude" })
	const wire =
		framer.start() +
		framer.chunk(chunkOf({ content: "thinking" })) +
		framer.chunk(
			chunkOf({
				tool_calls: [
					{ index: 0, id: "tu_1", function: { name: "get_weather", arguments: "" } },
				],
			}),
		) +
		framer.chunk(chunkOf({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] })) +
		framer.chunk(chunkOf({}, "tool_calls")) +
		framer.finish({ completion_tokens: 5 })

	const events = parse(wire)
	const payloads = events.map((e) => parseSseData<Record<string, unknown>>(e.data))

	// Text took index 0, so the tool block must take index 1.
	const toolStart = payloads.find(
		(p) =>
			p?.type === "content_block_start" &&
			(p.content_block as Record<string, unknown>).type === "tool_use",
	)
	assert.equal(toolStart?.index, 1)
	assert.equal((toolStart?.content_block as Record<string, unknown>).name, "get_weather")

	const jsonDelta = payloads.find(
		(p) => (p?.delta as Record<string, unknown> | undefined)?.type === "input_json_delta",
	)
	assert.equal((jsonDelta?.delta as Record<string, unknown>).partial_json, '{"a":1}')

	// Both blocks are closed, and the stop reason reflects the tool call.
	const stops = payloads.filter((p) => p?.type === "content_block_stop").map((p) => p?.index)
	assert.deepEqual(stops, [1, 0])
	const messageDelta = payloads.find((p) => p?.type === "message_delta")
	assert.equal((messageDelta?.delta as Record<string, unknown>).stop_reason, "tool_use")
})

test("an upstream that dies mid-stream still closes the message", () => {
	// Without the closing frames an anthropic client waits until it times out.
	const framer = createClientFramer("anthropic", { model: "claude" })
	const wire = framer.start() + framer.chunk(chunkOf({ content: "partial" })) + framer.finish()
	const names = parse(wire).map((e) => e.event)
	assert.equal(names[names.length - 1], "message_stop")
	assert.equal(names.includes("content_block_stop"), true)
})

test("finishing twice does not duplicate the closing frames", () => {
	const framer = createClientFramer("anthropic", { model: "claude" })
	framer.start()
	const first = framer.finish()
	const second = framer.finish()
	assert.equal(first.includes("message_stop"), true)
	assert.equal(second, "")
})

test("content containing a frame boundary cannot inject a frame", () => {
	// A model can be asked to emit a blank line. It must stay inside the data
	// payload rather than terminating the event (GW-011).
	const hostile = 'x\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'

	for (const dialect of ["openai", "gemini", "anthropic"] as const) {
		const framer = createClientFramer(dialect, { model: "m" })
		const wire = framer.chunk(chunkOf({ content: hostile }))
		const events = parse(wire)
		// One chunk in, one event out - never two.
		const injected = events.filter((e) => e.event === "message_stop")
		assert.equal(injected.length, 0, `${dialect} allowed an injected frame`)
	}
})
