/**
 * Redaction.
 *
 * Two findings live here. GW-005: an upstream provider echoes the key it was
 * given back inside its own error message, and a gateway that forwards that
 * body verbatim hands one customer the shared provider credential. GW-023:
 * prompt content in logs turns an observability tool into the most sensitive
 * store in the system.
 *
 * The interesting cases are not the obvious ones. A key with a recognisable
 * prefix is easy. What matters is the opaque secret that matches no pattern at
 * all -- which is why `redactKnown` exists and why it is always composed with
 * `redact` rather than used instead of it.
 */

process.env.IP_HASH_SECRET = "redaction-test-ip-secret"

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
	REDACTION,
	coarsenIp,
	hashIp,
	loggableHeaders,
	promptShape,
	redact,
	redactDeep,
	redactKnown,
	sanitizeOutbound,
} from "../../lib/http/redact.ts"

const OUR_KEY = "sk-ABCDEFGHIJKL1234567890"

describe("secret shapes in free text", () => {
	it("removes every provider key format it claims to know", () => {
		const samples: Array<[string, string]> = [
			["ours", OUR_KEY],
			["anthropic", "sk-ant-api03-ABCDEFGHIJKLMNOP1234"],
			["openai project", "sk-proj-ABCDEFGHIJKLMNOP1234"],
			["google api key", "AIzaSyA1234567890abcdefghijklmnopqrs"],
			["google oauth", "ya29.a0AfH6SMB1234567890abcdefg"],
			["aws access key", "AKIAIOSFODNN7EXAMPLE"],
			["aws session key", "ASIAIOSFODNN7EXAMPLE"],
			["github token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
			["slack token", "xoxb-1234567890-abcdefghij"],
			[
				"jwt",
				"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
			],
		]

		for (const [label, secret] of samples) {
			const out = redact(`the request failed using ${secret} as the credential`)
			assert.ok(out.includes(REDACTION), `${label}: nothing was redacted`)
			assert.ok(!out.includes(secret), `${label}: the secret survived`)
		}
	})

	it("redacts an authorization header value but keeps the header name", () => {
		const out = redact("authorization: Bearer abcdef1234567890ABCDEF")
		assert.ok(out.includes("authorization"))
		assert.ok(out.includes(REDACTION))
		assert.ok(!out.includes("abcdef1234567890ABCDEF"))
	})

	it("redacts each alternate auth header the gateway accepts", () => {
		for (const name of ["x-api-key", "x-goog-api-key", "mj-api-secret"]) {
			const out = redact(`${name}: qwertyuiop1234567890`)
			assert.ok(out.includes(name), `${name} was dropped entirely`)
			assert.ok(!out.includes("qwertyuiop1234567890"), `${name} value survived`)
		}
	})

	it("redacts a credential carried in a query string", () => {
		// Gemini clients that cannot set headers put the key in the url, which means
		// it reaches every access log on the path unless it is scrubbed.
		const out = redact("GET https://host/v1beta/models/x:generateContent?key=abcdefgh12345678&alt=sse")
		assert.ok(!out.includes("abcdefgh12345678"))
		assert.ok(out.includes("key="))
		assert.ok(out.includes("alt=sse"), "unrelated query parameters should survive")
	})

	it("redacts credential-shaped json fields", () => {
		const out = redact('{"api_key": "abcdefgh1234", "model": "gpt-4o"}')
		assert.ok(!out.includes("abcdefgh1234"))
		assert.ok(out.includes("gpt-4o"), "non-secret fields should be preserved")
	})

	it("leaves ordinary text alone", () => {
		const text = "the model returned a 429 after 3 retries in 1200ms"
		assert.equal(redact(text), text)
	})
})

describe("secrets that match no pattern", () => {
	// The real upstream credential is often an opaque blob with no prefix. This is
	// the case a pattern list can never cover, and the reason redactKnown exists.
	const opaque = "7f3a9c2b1d4e6f80a5b7c9d0e2f4a6b8"

	it("a pattern list does not catch an opaque secret", () => {
		assert.ok(redact(`key ${opaque} used`).includes(opaque))
	})

	it("redactKnown removes every occurrence of it", () => {
		const out = redactKnown(`first ${opaque} then ${opaque} again`, [opaque])
		assert.ok(!out.includes(opaque))
		assert.equal(out.split(REDACTION).length - 1, 2)
	})

	it("refuses to treat a short string as a secret", () => {
		// Blanking a five-character 'secret' would corrupt ordinary log lines.
		assert.equal(redactKnown("hello world", ["hello"]), "hello world")
		assert.equal(redactKnown("hello world", [null, undefined, ""]), "hello world")
	})

	it("sanitizeOutbound applies both passes, which is the GW-005 fix", () => {
		// A real OpenAI error body quotes the key it was handed.
		const body = JSON.stringify({
			error: {
				message: `Incorrect API key provided: ${OUR_KEY}. You can find your API key at https://platform.openai.com. Session ${opaque}`,
				type: "invalid_request_error",
			},
		})
		const out = sanitizeOutbound(body, [opaque])
		assert.ok(!out.includes(OUR_KEY), "the prefixed key survived")
		assert.ok(!out.includes(opaque), "the opaque secret survived")
		assert.ok(out.includes("invalid_request_error"), "the useful part was destroyed")
	})
})

describe("structured redaction", () => {
	it("blanks sensitive keys by name, not only by value shape", () => {
		const input = {
			// "Bearer x" matches no pattern; only the key name identifies it.
			authorization: "Bearer x",
			cookie: "fb_session=abc",
			nested: { api_key: "short", note: OUR_KEY },
			list: [OUR_KEY, 5],
			model: "gpt-4o",
		}
		const out = redactDeep(input)

		assert.equal(out.authorization, REDACTION)
		assert.equal(out.cookie, REDACTION)
		assert.equal(out.nested.api_key, REDACTION)
		assert.equal(out.nested.note, REDACTION)
		assert.equal(out.list[0], REDACTION)
		assert.equal(out.list[1], 5)
		assert.equal(out.model, "gpt-4o")
	})

	it("does not mutate its input", () => {
		const input = { authorization: "Bearer x" }
		redactDeep(input)
		assert.equal(input.authorization, "Bearer x")
	})

	it("stops walking at a bounded depth, which is why it is not the last defence", () => {
		// Build a structure deeper than the walk limit with a secret at the bottom.
		let node: Record<string, unknown> = { secret_at_the_bottom: OUR_KEY }
		for (let level = 0; level < 20; level += 1) node = { child: node }

		// It must not throw or recurse without bound...
		const out = redactDeep(node)
		assert.ok(out)

		// ...but a secret past the cap does survive the key walk. Anything that is
		// actually logged is serialised and passed through redact() as a string,
		// which has no depth to be defeated by.
		assert.ok(!redact(JSON.stringify(out)).includes(OUR_KEY))
	})
})

describe("what reaches a log sink", () => {
	it("drops unlisted headers entirely rather than redacting them", () => {
		const headers = new Headers({
			authorization: `Bearer ${OUR_KEY}`,
			cookie: "fb_session=abc",
			"x-api-key": OUR_KEY,
			"content-type": "application/json",
			"x-request-id": "req-1",
		})
		const out = loggableHeaders(headers)

		// An allowlist beats a denylist: a header nobody thought about is absent by
		// default rather than present by accident.
		assert.ok(!("authorization" in out))
		assert.ok(!("cookie" in out))
		assert.ok(!("x-api-key" in out))
		assert.equal(out["content-type"], "application/json")
		assert.equal(out["x-request-id"], "req-1")
		assert.ok(!JSON.stringify(out).includes(OUR_KEY))
	})

	it("caps the length of an allowlisted value", () => {
		const headers = new Headers({ "user-agent": "u".repeat(4000) })
		const out = loggableHeaders(headers)
		assert.equal(out["user-agent"]?.length, 256)
	})

	it("records prompt shape and never prompt content", () => {
		const secretPrompt = "the patient's diagnosis is confidential"
		const shape = promptShape(secretPrompt)
		assert.equal(shape.kind, "string")
		assert.equal(shape.chars, secretPrompt.length)
		assert.ok(!JSON.stringify(shape).includes("patient"))

		const messages = promptShape([{ role: "user", content: secretPrompt }])
		assert.equal(messages.kind, "array")
		assert.equal(messages.items, 1)
		assert.ok(!JSON.stringify(messages).includes("patient"))

		const object = promptShape({ input: secretPrompt, model: "gpt-4o" })
		assert.equal(object.kind, "object")
		assert.equal(object.keys, 2)
		assert.ok(!JSON.stringify(object).includes("patient"))

		assert.equal(promptShape(42).kind, "number")
	})
})

describe("client address handling", () => {
	it("stores a keyed digest, never the address", async () => {
		const ip = "203.0.113.9"
		const digest = await hashIp(ip)
		assert.equal(digest.length, 32)
		assert.match(digest, /^[0-9a-f]{32}$/)
		assert.ok(!digest.includes("203"))
		assert.equal(digest, await hashIp(ip), "the digest must be stable to be useful")
		assert.notEqual(digest, await hashIp("203.0.113.10"))
		assert.equal(await hashIp(""), "")
	})

	it("coarsens an address for display", () => {
		assert.equal(coarsenIp("203.0.113.9"), "203.0.113.x")
		assert.equal(coarsenIp("2001:db8::1"), "2001:db8::/32")
		assert.equal(coarsenIp("not-an-address"), "")
		assert.equal(coarsenIp(""), "")
	})
})

describe("bounded work", () => {
	it("truncates a huge input instead of scanning it all", () => {
		const started = Date.now()
		const out = redact(`${OUR_KEY} ${"x".repeat(200_000)}`)
		const elapsed = Date.now() - started

		assert.ok(out.includes("[truncated]"))
		assert.ok(!out.includes(OUR_KEY))
		assert.ok(elapsed < 2000, `redaction took ${elapsed}ms`)
	})

	it("is linear on adversarial input", () => {
		// A nested quantifier in any of these patterns would hang here (GW-021).
		const started = Date.now()
		redact(`authorization: ${"a".repeat(50_000)}`)
		redact(`{"api_key": "${"b".repeat(50_000)}`)
		const elapsed = Date.now() - started
		assert.ok(elapsed < 2000, `redaction took ${elapsed}ms`)
	})
})
