import test from "node:test"
import assert from "node:assert/strict"

import { guardStream, readCappedText } from "../../lib/upstream/fetch.ts"

const encoder = new TextEncoder()

function streamOf(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
	let i = 0
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (i >= chunks.length) {
				controller.close()
				return
			}
			if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
			controller.enqueue(encoder.encode(chunks[i++]))
		},
	})
}

/** A stream that opens and then says nothing, like a stalled upstream. */
function silentStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => undefined)
		},
	})
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let out = ""
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		out += decoder.decode(value, { stream: true })
	}
	return out
}

test("a well-behaved stream passes through untouched", async () => {
	const out = await drain(
		guardStream(streamOf(["hello ", "world"]), { maxBytes: 1000, idleMs: 1000 }),
	)
	assert.equal(out, "hello world")
})

test("an oversized body is cut off rather than buffered", async () => {
	const chunks = Array.from({ length: 100 }, () => "x".repeat(100)) // 10 KB
	const guarded = guardStream(streamOf(chunks), { maxBytes: 512, idleMs: 1000 })
	await assert.rejects(() => drain(guarded), /exceeded 512 bytes/)
})

test("the cap counts cumulative bytes, not chunk size", async () => {
	// No single chunk exceeds the cap; their sum does.
	const guarded = guardStream(streamOf(["aaaa", "bbbb", "cccc"]), { maxBytes: 10, idleMs: 1000 })
	await assert.rejects(() => drain(guarded), /exceeded 10 bytes/)
})

test("a stalled upstream times out instead of hanging", async () => {
	const started = Date.now()
	const guarded = guardStream(silentStream(), { maxBytes: 1000, idleMs: 80 })
	await assert.rejects(() => drain(guarded), /stalled for 80ms/)
	const elapsed = Date.now() - started
	assert.ok(elapsed < 2000, `should have given up quickly, took ${elapsed}ms`)
})

test("a slow but progressing stream is not killed", async () => {
	// Chunks arrive steadily below the idle threshold, which is legitimate for
	// a long generation and must not be mistaken for a stall.
	const guarded = guardStream(streamOf(["a", "b", "c", "d"], 20), { maxBytes: 1000, idleMs: 200 })
	assert.equal(await drain(guarded), "abcd")
})

test("disabling the limits is possible but explicit", async () => {
	const guarded = guardStream(streamOf(["a".repeat(5000)]), { maxBytes: 0, idleMs: 0 })
	assert.equal((await drain(guarded)).length, 5000)
})

test("buffered reads honour the same cap", async () => {
	const ok = new Response(streamOf(["small body"]))
	assert.equal(await readCappedText(ok, 1000), "small body")

	const big = new Response(streamOf(["y".repeat(4000)]))
	await assert.rejects(() => readCappedText(big, 100), /exceeded 100 bytes/)

	// An empty body is not an error.
	assert.equal(await readCappedText(new Response(null), 100), "")
})
