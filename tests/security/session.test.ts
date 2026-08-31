process.env.SESSION_SECRET = "console-session-secret-for-tests"

import test from "node:test"
import assert from "node:assert/strict"

import {
	CSRF_COOKIE,
	CSRF_HEADER,
	SESSION_COOKIE,
	assertCsrf,
	clearedSessionCookies,
	createSession,
	csrfTokenFor,
	readCookie,
	readSession,
	sessionCookies,
	withCookies,
} from "../../lib/admin/session.ts"
import type { UserDoc } from "../../lib/db/types.ts"
import { signToken } from "../../lib/util/crypto.ts"
import { nowSec } from "../../lib/util/time.ts"

const admin: UserDoc = {
	_id: "u-admin",
	username: "root",
	displayName: "Root",
	email: "root@example.com",
	role: "admin",
	status: "enabled",
	group: "default",
	quota: 0,
	usedQuota: 0,
	requestCount: 0,
	createdAt: new Date(),
	updatedAt: new Date(),
}

function request(
	cookies: Record<string, string>,
	init: { method?: string; headers?: Record<string, string> } = {},
): Request {
	const cookie = Object.entries(cookies)
		.map(([name, value]) => name + "=" + encodeURIComponent(value))
		.join("; ")
	return new Request("https://gateway.test/api/admin/users", {
		method: init.method ?? "GET",
		headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
	})
}

test("a session cookie round-trips", async () => {
	const { token, payload } = await createSession(admin)
	const session = await readSession(request({ [SESSION_COOKIE]: token }))
	assert.ok(session)
	assert.equal(session.sub, "u-admin")
	assert.equal(session.role, "admin")
	assert.equal(session.sid, payload.sid)
})

test("no cookie means no session, without throwing", async () => {
	assert.equal(await readSession(request({})), null)
})

test("a tampered session is rejected", async () => {
	const { token } = await createSession(admin)
	// Flip one character of the signature.
	const dot = token.indexOf(".")
	const signature = token.slice(dot + 1)
	const flipped = (signature[0] === "a" ? "b" : "a") + signature.slice(1)
	const forged = token.slice(0, dot + 1) + flipped
	assert.equal(await readSession(request({ [SESSION_COOKIE]: forged })), null)
})

test("a body rewritten to claim root is rejected", async () => {
	// The payload is readable, so the only thing stopping privilege escalation
	// is the signature. Prove it.
	const { token } = await createSession(admin)
	const dot = token.indexOf(".")
	const body = JSON.parse(
		Buffer.from(token.slice(0, dot), "base64url").toString("utf8"),
	) as Record<string, unknown>
	assert.equal(body.role, "admin")
	body.role = "root"
	const rewritten =
		Buffer.from(JSON.stringify(body), "utf8").toString("base64url") + token.slice(dot)
	assert.equal(await readSession(request({ [SESSION_COOKIE]: rewritten })), null)
})

test("an expired session is rejected", async () => {
	const expired = await signToken(
		{ sub: "u-admin", username: "root", role: "admin", sid: "s1", exp: nowSec() - 5 },
		"console-session-secret-for-tests",
	)
	assert.equal(await readSession(request({ [SESSION_COOKIE]: expired })), null)
})

test("rotating the secret invalidates existing sessions", async () => {
	const { token } = await createSession(admin)
	const previous = process.env.SESSION_SECRET
	process.env.SESSION_SECRET = "a-different-secret-entirely"
	try {
		assert.equal(await readSession(request({ [SESSION_COOKIE]: token })), null)
	} finally {
		process.env.SESSION_SECRET = previous
	}
})

test("a blank secret fails closed", async () => {
	const previous = process.env.SESSION_SECRET
	process.env.SESSION_SECRET = ""
	try {
		await assert.rejects(createSession(admin), /SESSION_SECRET is not configured/)
	} finally {
		process.env.SESSION_SECRET = previous
	}
})

test("reads are not gated on CSRF", async () => {
	const { payload } = await createSession(admin)
	await assertCsrf(request({}, { method: "GET" }), payload)
	await assertCsrf(request({}, { method: "HEAD" }), payload)
})

test("a write without a CSRF header is refused", async () => {
	const { token, payload } = await createSession(admin)
	await assert.rejects(
		assertCsrf(request({ [SESSION_COOKIE]: token }, { method: "POST" }), payload),
		/CSRF/i,
	)
})

test("a write with the matching CSRF header is allowed", async () => {
	const { token, csrf, payload } = await createSession(admin)
	await assertCsrf(
		request(
			{ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
			{ method: "POST", headers: { [CSRF_HEADER]: csrf } },
		),
		payload,
	)
})

test("the cookie copy of the CSRF token is not proof of itself", async () => {
	// This is the whole point of double-submit. A cross-site form post makes the
	// browser attach every cookie we set, including fb_csrf. If the cookie alone
	// satisfied the check, the token would be worthless.
	const { token, csrf, payload } = await createSession(admin)
	await assert.rejects(
		assertCsrf(
			request({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }, { method: "POST" }),
			payload,
		),
		/CSRF/i,
	)
})

test("another session's CSRF token does not work", async () => {
	const mine = await createSession(admin)
	const theirs = await createSession({ ...admin, _id: "u-other", username: "other" })
	assert.notEqual(mine.csrf, theirs.csrf)
	await assert.rejects(
		assertCsrf(
			request({ [SESSION_COOKIE]: mine.token }, { method: "POST", headers: { [CSRF_HEADER]: theirs.csrf } }),
			mine.payload,
		),
		/CSRF/i,
	)
})

test("the CSRF token is not derivable from the visible session id", async () => {
	// sid travels in the clear inside the cookie body, so the token must depend
	// on the server secret too.
	const { payload, csrf } = await createSession(admin)
	const previous = process.env.SESSION_SECRET
	process.env.SESSION_SECRET = "a-different-secret-entirely"
	try {
		assert.notEqual(await csrfTokenFor(payload.sid), csrf)
	} finally {
		process.env.SESSION_SECRET = previous
	}
})

test("a foreign origin is refused outright", async () => {
	const { token, csrf, payload } = await createSession(admin)
	const previous = process.env.PUBLIC_BASE_URL
	process.env.PUBLIC_BASE_URL = "https://gateway.test"
	try {
		await assert.rejects(
			assertCsrf(
				request(
					{ [SESSION_COOKIE]: token },
					{ method: "POST", headers: { [CSRF_HEADER]: csrf, origin: "https://evil.example" } },
				),
				payload,
			),
			/origin is not allowed/i,
		)
		// Our own origin still passes.
		await assertCsrf(
			request(
				{ [SESSION_COOKIE]: token },
				{ method: "POST", headers: { [CSRF_HEADER]: csrf, origin: "https://gateway.test" } },
			),
			payload,
		)
	} finally {
		process.env.PUBLIC_BASE_URL = previous
	}
})

test("the session cookie is HttpOnly and the CSRF cookie is not", async () => {
	const { token, csrf } = await createSession(admin)
	const [session, csrfCookie] = sessionCookies(token, csrf)
	assert.match(session, /HttpOnly/)
	assert.match(session, /SameSite=Lax/)
	assert.match(session, /Path=\//)
	// The console's own script has to read this one to echo it back.
	assert.doesNotMatch(csrfCookie, /HttpOnly/)
})

test("signing out expires both cookies", () => {
	for (const value of clearedSessionCookies()) {
		assert.match(value, /Max-Age=0/)
	}
})

test("cookies are appended, never collapsed into one header", async () => {
	const { token, csrf } = await createSession(admin)
	const response = withCookies(
		new Response("{}", { headers: { "content-type": "application/json" } }),
		sessionCookies(token, csrf),
	)
	const all = response.headers.getSetCookie()
	assert.equal(all.length, 2)
	assert.equal(response.headers.get("content-type"), "application/json")
})

test("cookie parsing tolerates junk", () => {
	const req = new Request("https://gateway.test/", {
		headers: { cookie: "; ;=broken; other=1; " + SESSION_COOKIE + "=value" },
	})
	assert.equal(readCookie(req, SESSION_COOKIE), "value")
	assert.equal(readCookie(req, "missing"), "")
})
