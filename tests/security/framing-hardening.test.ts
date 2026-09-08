import test from "node:test"
import assert from "node:assert/strict"
import { createSseParser, createNdjsonParser } from "../../lib/transform/sse.ts"

test("a complete oversized SSE line cannot bypass the unfinished-line limit", () => {
	const parser = createSseParser({ maxLineBytes: 20 })
	assert.throws(() => parser.push("data: " + "x".repeat(21) + "\n\n"), /line|bytes/i)
})

test("many short data lines cannot accumulate an unbounded SSE event", () => {
	const parser = createSseParser({ maxLineBytes: 20 })
	assert.throws(() => parser.push("data: x\n".repeat(20)), /event|bytes/i)
})

test("SSE line limits count actual UTF-8 bytes", () => {
	const parser = createSseParser({ maxLineBytes: 10 })
	assert.throws(() => parser.push("data: 猫猫\n\n"), /line|bytes/i)
})

test("CRLF split across chunks does not create an extra event boundary", () => {
	const parser = createSseParser()
	assert.deepEqual(parser.push("data: first\r"), [])
	assert.deepEqual(parser.push("\ndata: second\r"), [])
	const events = parser.push("\n\r\n")
	assert.equal(events.length, 1)
	assert.equal(events[0].data, "first\nsecond")
})

test("a newline-terminated oversized NDJSON record is bounded too", () => {
	const parser = createNdjsonParser({ maxLineBytes: 10 })
	assert.throws(() => parser.push("x".repeat(20) + "\n"), /line|bytes/i)
})