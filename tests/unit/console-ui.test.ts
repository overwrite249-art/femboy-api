import test from "node:test"
import assert from "node:assert/strict"
import {
	csvCell,
	curlExample,
	matchesSearch,
	monthBucket,
	toCsv,
	tokenState,
} from "../../lib/console/client-utils.ts"
import {
	readBoundedResponse,
	responseMessage,
} from "../../lib/console/playground.ts"

test("console search is case-insensitive, multi-term, and handles missing fields", () => {
	assert.equal(
		matchesSearch("OPEN primary", "OpenAI", "my-primary", undefined),
		true,
	)
	assert.equal(matchesSearch("open missing", "OpenAI", "primary"), false)
	assert.equal(matchesSearch(" ", null), true)
	assert.equal(matchesSearch("claude", ["gpt-4o", "claude-sonnet"]), true)
})
test("CSV cells quote correctly and neutralize spreadsheet formulas", () => {
	for (const value of [
		"=1+1",
		"+cmd",
		"-1+cmd",
		"@SUM(1)",
		" \t=HYPERLINK(1)",
		"\u0000=1",
		"\tcell",
		"\rtext",
		"\ntext",
	])
		assert.ok(csvCell(value).startsWith("\"'"))
	assert.equal(csvCell('hello,"world"'), '"hello,""world"""')
	assert.equal(csvCell(null), '""')
	assert.equal(
		toCsv(["Model", "Count"], [["a,b", 0]]),
		'"Model","Count"\r\n"a,b","0"\r\n',
	)
})
test("usage month inputs become exact UTC bucket identifiers", () => {
	assert.equal(monthBucket("2026-09"), "202609")
	for (const value of [
		"2026-13",
		"2026-00",
		"2026-1",
		"",
		"202609",
		"2026-09&x=1",
	])
		assert.equal(monthBucket(value), "")
})
test("expired enabled tokens are visibly distinguished from disabled keys", () => {
	assert.equal(
		tokenState(
			{ status: "enabled", expiresAt: "2026-01-01T00:00:00Z" },
			Date.parse("2026-01-02"),
		),
		"expired",
	)
	assert.equal(tokenState({ status: "enabled", expiresAt: null }), "enabled")
	assert.equal(
		tokenState({ status: "disabled", expiresAt: "2020-01-01" }),
		"disabled",
	)
})
test("copied cURL is shell-escaped and uses a key placeholder only", () => {
	const text = curlExample("https://gateway.example/ignored", {
		model: "example",
		messages: [{ role: "user", content: "It's a test" }],
	})
	assert.ok(text.includes("Authorization: Bearer $FEMBOY_API_KEY"))
	assert.ok(text.includes("It'\\''s a test"))
	assert.ok(text.includes("https://gateway.example/v1/chat/completions"))
	assert.ok(!text.includes("/ignored"))
})
test("playground rejects oversized streamed responses and cancels reading", async () => {
	let cancelled = false
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(10))
				controller.enqueue(new Uint8Array(10))
			},
			cancel() {
				cancelled = true
			},
		}),
	)
	await assert.rejects(readBoundedResponse(response, 12), /display limit/)
	assert.equal(cancelled, true)
})
test("playground decoding handles split UTF-8 and empty bodies", async () => {
	const bytes = new TextEncoder().encode("Hi 👋")
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(bytes.slice(0, 5))
				controller.enqueue(bytes.slice(5))
				controller.close()
			},
		}),
	)
	assert.equal(await readBoundedResponse(response), "Hi 👋")
	assert.equal(await readBoundedResponse(new Response(null)), "")
})
test("playground treats model output as text, never markup", () => {
	assert.equal(
		responseMessage({
			choices: [{ message: { content: "<script>not HTML</script>" } }],
		}),
		"<script>not HTML</script>",
	)
	assert.equal(
		responseMessage({ error: { message: "Quota exhausted" } }),
		"Quota exhausted",
	)
	assert.match(responseMessage({ choices: [] }), /JSON tab/)
	assert.equal(responseMessage(null), "")
})
