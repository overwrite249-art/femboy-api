/**
 * Header hygiene.
 *
 * A proxy's header handling is where several unrelated attacks meet. The
 * client wants to reach the provider with headers it should not control; the
 * provider wants to reach the client with metadata it should not see; and a
 * channel row in the database is operator-supplied data that ends up in an
 * outbound request. All three are tested here.
 *
 * One note on what is testable: `new Headers()` refuses CR and LF at
 * construction, so a client cannot even build an injecting header through the
 * fetch API. The injection tests therefore exercise the paths where a value
 * arrives from the database as a plain object -- which is the real vector.
 */

process.env.TRUSTED_PROXY_HOPS = "1"
process.env.SITE_NAME = "femboy-api"

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
	DEFAULT_FORWARD_LIST,
	HeaderInjectionError,
	assertSafeHeaderName,
	assertSafeHeaderValue,
	bearerFrom,
	buildUpstreamHeaders,
	filterDownstreamHeaders,
	getClientIp,
	hasHeaderInjection,
	normalizeIp,
	sanitizeHeaderValue,
} from "../../lib/http/headers.ts"

const CLIENT_KEY = "sk-client-ABCDEFGHIJKL1234"
const PROVIDER_KEY = "sk-provider-ZYXWVUTSRQPO9876"

function clientRequestHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		authorization: `Bearer ${CLIENT_KEY}`,
		cookie: "fb_session=abc",
		"x-api-key": CLIENT_KEY,
		"x-admin-token": "admin-bootstrap",
		"x-forwarded-for": "203.0.113.9",
		"anthropic-version": "2023-06-01",
		"x-stainless-lang": "js",
		"x-whatever-the-client-invented": "1",
		"content-length": "123",
		host: "gateway.test",
		...extra,
	})
}

describe("the outbound request", () => {
	it("never forwards the client's own credential", () => {
		const out = buildUpstreamHeaders({
			clientHeaders: clientRequestHeaders(),
			authHeaders: { authorization: `Bearer ${PROVIDER_KEY}` },
		})

		// The single most important assertion in the file: what the provider sees
		// is the channel's credential, and the client's key is simply gone.
		assert.equal(out.get("authorization"), `Bearer ${PROVIDER_KEY}`)
		const serialised = JSON.stringify([...out.entries()])
		assert.ok(!serialised.includes(CLIENT_KEY), "the client key reached the provider")
		assert.equal(out.get("x-api-key"), null)
		assert.equal(out.get("cookie"), null)
		assert.equal(out.get("x-admin-token"), null)
	})

	it("drops connection and routing headers", () => {
		const out = buildUpstreamHeaders({
			clientHeaders: clientRequestHeaders(),
			authHeaders: { authorization: `Bearer ${PROVIDER_KEY}` },
		})
		assert.equal(out.get("host"), null)
		assert.equal(out.get("content-length"), null)
		assert.equal(out.get("x-forwarded-for"), null)
	})

	it("forwards only headers on the list, defaulting to drop", () => {
		const out = buildUpstreamHeaders({
			clientHeaders: clientRequestHeaders(),
			authHeaders: { authorization: `Bearer ${PROVIDER_KEY}` },
		})
		// On the list: providers act on these.
		assert.equal(out.get("anthropic-version"), "2023-06-01")
		assert.equal(out.get("x-stainless-lang"), "js")
		// Not on the list: absent by default, not by having been thought about.
		assert.equal(out.get("x-whatever-the-client-invented"), null)
		assert.ok(DEFAULT_FORWARD_LIST.includes("anthropic-version"))
		assert.ok(!DEFAULT_FORWARD_LIST.includes("authorization"))
	})

	it("honours an explicit forward list", () => {
		const out = buildUpstreamHeaders({
			clientHeaders: clientRequestHeaders(),
			authHeaders: { authorization: `Bearer ${PROVIDER_KEY}` },
			forwardList: ["x-whatever-the-client-invented"],
		})
		assert.equal(out.get("x-whatever-the-client-invented"), "1")
		// Narrowing the list does not widen what is forbidden.
		assert.equal(out.get("cookie"), null)
		assert.equal(out.get("anthropic-version"), null)
	})

	it("refuses to let a channel header overwrite the credential", () => {
		// A channel row is operator data. An operator with write access to one
		// channel must not be able to redirect another tenant's credential.
		const out = buildUpstreamHeaders({
			clientHeaders: new Headers(),
			authHeaders: { authorization: `Bearer ${PROVIDER_KEY}` },
			channelHeaders: {
				authorization: "Bearer channel-supplied-override",
				"x-api-key": "channel-supplied-override",
				"x-region": "eu",
			},
		})
		assert.equal(out.get("authorization"), `Bearer ${PROVIDER_KEY}`)
		assert.equal(out.get("x-api-key"), null)
		// A benign channel header still works.
		assert.equal(out.get("x-region"), "eu")
	})

	it("rejects a channel header carrying control characters", () => {
		// This is the GW-011 vector that a Headers object cannot express.
		assert.throws(
			() =>
				buildUpstreamHeaders({
					clientHeaders: new Headers(),
					authHeaders: {},
					channelHeaders: { "x-region": "eu\r\nx-injected: yes" },
				}),
			HeaderInjectionError,
		)
	})

	it("rejects a channel header with an illegal name", () => {
		assert.throws(
			() =>
				buildUpstreamHeaders({
					clientHeaders: new Headers(),
					authHeaders: {},
					channelHeaders: { "x bad name": "value" },
				}),
			HeaderInjectionError,
		)
	})

	it("sets a stable user agent and a default accept", () => {
		const out = buildUpstreamHeaders({
			clientHeaders: new Headers(),
			authHeaders: {},
		})
		assert.equal(out.get("user-agent"), "femboy-api/1.0")
		assert.equal(out.get("accept"), "application/json")
	})

	it("lets the client's accept header win when it sent one", () => {
		const out = buildUpstreamHeaders({
			clientHeaders: new Headers({ accept: "text/event-stream" }),
			authHeaders: {},
		})
		assert.equal(out.get("accept"), "text/event-stream")
	})

	it("applies the content type it was given", () => {
		const out = buildUpstreamHeaders({
			clientHeaders: new Headers({ "content-type": "application/json" }),
			authHeaders: {},
			contentType: "multipart/form-data; boundary=abc",
		})
		assert.equal(out.get("content-type"), "multipart/form-data; boundary=abc")
	})
})

describe("the inbound response", () => {
	function upstreamHeaders(): Headers {
		return new Headers({
			"content-type": "application/json",
			"content-encoding": "gzip",
			"content-length": "999",
			"set-cookie": "provider_session=abc",
			authorization: `Bearer ${PROVIDER_KEY}`,
			"openai-organization": "org-secret-tenant",
			"openai-project": "proj-secret",
			"x-request-id": "provider-request-id",
			"cf-ray": "abc-DFW",
			server: "cloudflare",
			"retry-after": "30",
			"x-ratelimit-remaining-requests": "41",
			"x-served-by": "pod-17",
			"x-something-new": "1",
		})
	}

	it("hides provider account identity from the client", () => {
		const out = filterDownstreamHeaders(upstreamHeaders())
		assert.equal(out.get("openai-organization"), null)
		assert.equal(out.get("openai-project"), null)
		assert.equal(out.get("set-cookie"), null)
		assert.equal(out.get("authorization"), null)
		assert.equal(out.get("cf-ray"), null)
		assert.equal(out.get("server"), null)
		assert.equal(out.get("x-served-by"), null)
		assert.ok(!JSON.stringify([...out.entries()]).includes(PROVIDER_KEY))
	})

	it("keeps the headers clients actually act on", () => {
		const out = filterDownstreamHeaders(upstreamHeaders())
		assert.equal(out.get("content-type"), "application/json")
		assert.equal(out.get("retry-after"), "30")
		assert.equal(out.get("x-ratelimit-remaining-requests"), "41")
	})

	it("drops transport framing it must regenerate itself", () => {
		// Forwarding content-encoding after the body has been decoded, or a
		// content-length that no longer matches, breaks the client in ways that
		// look like gateway corruption.
		const out = filterDownstreamHeaders(upstreamHeaders())
		assert.equal(out.get("content-encoding"), null)
		assert.equal(out.get("content-length"), null)
	})

	it("drops an unknown provider header rather than guessing", () => {
		const out = filterDownstreamHeaders(upstreamHeaders())
		assert.equal(out.get("x-something-new"), null)
	})

	it("replaces the provider's request id rather than passing it through", () => {
		// The gateway issues its own request id; the provider's would make support
		// requests point at the wrong system.
		const out = filterDownstreamHeaders(upstreamHeaders())
		assert.equal(out.get("x-request-id"), null)
	})
})

describe("resolving the client address", () => {
	it("reads X-Forwarded-For from the right, not the left", () => {
		// Every hop appends. The leftmost entry is whatever the caller claimed.
		const headers = new Headers({ "x-forwarded-for": "9.9.9.9, 1.1.1.1, 203.0.113.9" })
		assert.equal(getClientIp(headers), "203.0.113.9")
	})

	it("ignores a spoofed prefix entirely (GW-006)", () => {
		// A caller pretending to be a trusted internal address gains nothing.
		const honest = getClientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))
		const spoofed = getClientIp(
			new Headers({ "x-forwarded-for": "127.0.0.1, 10.0.0.1, 203.0.113.9" }),
		)
		assert.equal(honest, "203.0.113.9")
		assert.equal(spoofed, "203.0.113.9")
	})

	it("counts the configured number of trusted hops", () => {
		const headers = new Headers({ "x-forwarded-for": "9.9.9.9, 1.1.1.1, 203.0.113.9" })
		assert.equal(getClientIp(headers, 2), "1.1.1.1")
		assert.equal(getClientIp(headers, 3), "9.9.9.9")
		// More hops than entries cannot read past the start of the list.
		assert.equal(getClientIp(headers, 99), "9.9.9.9")
		// Zero is treated as one rather than as an index error.
		assert.equal(getClientIp(headers, 0), "203.0.113.9")
	})

	it("falls back to platform-set single-value headers", () => {
		assert.equal(getClientIp(new Headers({ "x-real-ip": "203.0.113.9" })), "203.0.113.9")
		assert.equal(
			getClientIp(new Headers({ "cf-connecting-ip": "203.0.113.9" })),
			"203.0.113.9",
		)
	})

	it("returns empty rather than a guess when there is nothing to read", () => {
		assert.equal(getClientIp(new Headers()), "")
		assert.equal(getClientIp(new Headers({ "x-forwarded-for": "not-an-address" })), "")
	})

	it("normalises the forms a proxy actually emits", () => {
		assert.equal(normalizeIp("203.0.113.9:54321"), "203.0.113.9")
		assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8::1")
		assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9")
		assert.equal(normalizeIp("  2001:DB8::1  "), "2001:db8::1")
		assert.equal(normalizeIp("example.com"), "")
		assert.equal(normalizeIp("<script>"), "")
	})
})

describe("value safety primitives", () => {
	it("detects every control character that enables splitting", () => {
		for (const bad of ["a\rb", "a\nb", "a\r\nb", "a\0b", "a\x0bb", "a\x1fb", "a\x7fb"]) {
			assert.ok(hasHeaderInjection(bad), `missed ${JSON.stringify(bad)}`)
		}
		assert.ok(!hasHeaderInjection("application/json; charset=utf-8"))
		assert.ok(!hasHeaderInjection("Bearer sk-abc.def-ghi_jkl"))
	})

	it("rejects rather than sanitises, so an attack is visible", () => {
		// Silently stripping CRLF would turn an attack into a successful request.
		assert.throws(() => assertSafeHeaderValue("x-test", "a\r\nb"), HeaderInjectionError)
		assert.equal(assertSafeHeaderValue("x-test", "fine"), "fine")
	})

	it("caps header value length", () => {
		assert.throws(
			() => assertSafeHeaderValue("x-test", "a".repeat(8_193)),
			HeaderInjectionError,
		)
		assert.equal(assertSafeHeaderValue("x-test", "a".repeat(8_192)).length, 8_192)
	})

	it("validates and lower-cases header names", () => {
		assert.equal(assertSafeHeaderName("X-Custom-Header"), "x-custom-header")
		for (const bad of ["x custom", "x:custom", "x\r\ny", "", "x/y"]) {
			assert.throws(() => assertSafeHeaderName(bad), HeaderInjectionError)
		}
	})

	it("sanitises values for headers we emit ourselves", () => {
		// Our own values (a site name, an error summary) are cleaned rather than
		// rejected, because failing a response over our own formatting is worse.
		const cleaned = sanitizeHeaderValue("line1\r\nline2\0end")
		assert.ok(!hasHeaderInjection(cleaned))
		assert.ok(cleaned.includes("line1"))
		assert.ok(cleaned.includes("line2"))
		assert.equal(sanitizeHeaderValue("x".repeat(9_000)).length, 8_192)
	})

	it("extracts a bearer token in the forms clients send", () => {
		assert.equal(bearerFrom(new Headers({ authorization: "Bearer sk-abc123" })), "sk-abc123")
		assert.equal(bearerFrom(new Headers({ authorization: "bearer   sk-abc123  " })), "sk-abc123")
		// Some clients omit the scheme entirely.
		assert.equal(bearerFrom(new Headers({ authorization: "sk-abc123" })), "sk-abc123")
		assert.equal(bearerFrom(new Headers()), "")
	})
})
