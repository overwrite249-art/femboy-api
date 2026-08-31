process.env.SESSION_SECRET = "admin-test-session-secret"
process.env.KEY_PEPPER = "admin-test-pepper"
process.env.IP_HASH_SECRET = "admin-test-ip-secret"
process.env.CHANNEL_KEY_MASTER = "unit-test-master-key-0123456789abcdef"
process.env.CHANNEL_KEY_VERSION = "1"
process.env.MIN_AUTH_LATENCY_MS = "0"
process.env.TRUSTED_PROXY_HOPS = "1"

import test from "node:test"
import assert from "node:assert/strict"

import { handleAdminRequest } from "../../lib/admin/router.ts"
import { handleAuthRequest } from "../../lib/admin/login.ts"
import { hashPassword } from "../../lib/admin/password.ts"
import { createRedemptionBatch, redeemCode } from "../../lib/admin/catalog.ts"
import { createToken, createUser } from "../../lib/admin/store.ts"
import {
	CSRF_COOKIE,
	CSRF_HEADER,
	SESSION_COOKIE,
	createSession,
} from "../../lib/admin/session.ts"
import { authenticate } from "../../lib/auth/authenticate.ts"
import { auditLogs, channelKeys, oauthStates, setDb, tokens, users } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import type { UserDoc } from "../../lib/db/types.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"

type World = {
	admin: UserDoc
	adminKey: string
	member: UserDoc
	memberKey: string
}

async function fresh(): Promise<World> {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())

	const admin = await createUser({ username: "root", role: "root" })
	const adminToken = await createToken({
		userId: admin._id,
		name: "admin",
		unlimitedQuota: true,
	})
	const member = await createUser({ username: "mallory", role: "user", quota: 100 })
	const memberToken = await createToken({ userId: member._id, name: "member" })

	return {
		admin,
		adminKey: adminToken.key,
		member,
		memberKey: memberToken.key,
	}
}

function adminRequest(
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): { req: Request; segments: string[] } {
	const req = new Request("https://gateway.test/api/admin/" + path, {
		method: init.method ?? "GET",
		headers: {
			"content-type": "application/json",
			"x-forwarded-for": "203.0.113.9",
			...(init.headers ?? {}),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	})
	const segments = path
		.split("?")[0]
		.split("/")
		.filter((part) => part.length > 0)
	return { req, segments }
}

async function call(
	path: string,
	init: Parameters<typeof adminRequest>[1] = {},
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
	const { req, segments } = adminRequest(path, init)
	const response = await handleAdminRequest(req, segments)
	const text = await response.clone().text()
	let body: Record<string, unknown> = {}
	try {
		body = JSON.parse(text) as Record<string, unknown>
	} catch {
		body = { raw: text }
	}
	return { status: response.status, body, response }
}

function bearer(key: string): Record<string, string> {
	return { authorization: `Bearer ${key}` }
}

function messageOf(text: string): string {
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string } }
		return parsed.error?.message ?? text
	} catch {
		return text
	}
}

test("an anonymous request cannot reach the control plane", async () => {
	await fresh()
	const { status } = await call("users")
	assert.equal(status, 401)
})

test("an ordinary user's key is refused", async () => {
	const world = await fresh()
	const { status } = await call("users", { headers: bearer(world.memberKey) })
	assert.equal(status, 403)
})

test("an admin key is accepted", async () => {
	const world = await fresh()
	const { status, body } = await call("users", { headers: bearer(world.adminKey) })
	assert.equal(status, 200)
	assert.equal((body.users as unknown[]).length, 2)
})

test("a console session cannot be used as a relay credential", async () => {
	// GW-018, in the direction that matters most: stealing a session cookie via
	// XSS must not yield the ability to spend the account's quota on inference.
	const world = await fresh()
	const { token } = await createSession(world.admin)
	const req = new Request("https://gateway.test/v1/chat/completions", {
		method: "POST",
		headers: { cookie: `${SESSION_COOKIE}=${token}` },
	})
	await assert.rejects(authenticate(req))
})

test("a relay key is still accepted by the relay authenticator", async () => {
	// The mirror image of the test above: proving the refusal is about the
	// credential type, not a broken authenticator.
	const world = await fresh()
	const req = new Request("https://gateway.test/v1/chat/completions", {
		method: "POST",
		headers: { ...bearer(world.memberKey), "x-forwarded-for": "203.0.113.9" },
	})
	const context = await authenticate(req)
	assert.equal(context.identity.username, "mallory")
})

test("a session authenticates reads", async () => {
	const world = await fresh()
	const { token } = await createSession(world.admin)
	const { status } = await call("users", {
		headers: { cookie: `${SESSION_COOKIE}=${token}` },
	})
	assert.equal(status, 200)
})

test("a session write without the CSRF header is refused", async () => {
	const world = await fresh()
	const { token, csrf } = await createSession(world.admin)
	const { status } = await call("users", {
		method: "POST",
		// Both cookies present, no header: exactly what a cross-site form post
		// would produce.
		headers: { cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${csrf}` },
		body: { username: "newcomer" },
	})
	assert.equal(status, 403)
	assert.equal(await (await users()).countDocuments({ username: "newcomer" }), 0)
})

test("a session write with the CSRF header succeeds", async () => {
	const world = await fresh()
	const { token, csrf } = await createSession(world.admin)
	const { status } = await call("users", {
		method: "POST",
		headers: {
			cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${csrf}`,
			[CSRF_HEADER]: csrf,
		},
		body: { username: "newcomer" },
	})
	assert.equal(status, 201)
	assert.equal(await (await users()).countDocuments({ username: "newcomer" }), 1)
})

test("an API key does not need a CSRF token", async () => {
	// A key is not ambient: it is only present if the caller deliberately
	// attached it, so there is nothing for CSRF to protect against.
	const world = await fresh()
	const { status } = await call("users", {
		method: "POST",
		headers: bearer(world.adminKey),
		body: { username: "scripted" },
	})
	assert.equal(status, 201)
})

test("the network fence outranks a valid credential", async () => {
	const world = await fresh()
	const previous = process.env.ADMIN_ALLOWED_CIDRS
	process.env.ADMIN_ALLOWED_CIDRS = "10.0.0.0/8"
	try {
		const blocked = await call("users", {
			headers: { ...bearer(world.adminKey), "x-forwarded-for": "203.0.113.9" },
		})
		assert.equal(blocked.status, 403)

		const allowed = await call("users", {
			headers: { ...bearer(world.adminKey), "x-forwarded-for": "10.1.2.3" },
		})
		assert.equal(allowed.status, 200)
	} finally {
		process.env.ADMIN_ALLOWED_CIDRS = previous
	}
})

test("a minted key is returned once and never stored", async () => {
	const world = await fresh()
	const { status, body } = await call("tokens", {
		method: "POST",
		headers: bearer(world.adminKey),
		body: { userId: world.member._id, name: "fresh" },
	})
	assert.equal(status, 201)
	const key = String(body.key)
	assert.match(key, /^sk-/)

	// The stored row must not contain the plaintext anywhere in it.
	const stored = await (await tokens()).find({ name: "fresh" })
	assert.equal(stored.length, 1)
	assert.ok(!JSON.stringify(stored[0]).includes(key.slice(3)))

	// Listing tokens must not hand it back either.
	const listed = await call("tokens", { headers: bearer(world.adminKey) })
	assert.ok(!JSON.stringify(listed.body).includes(key.slice(3)))
	assert.ok(!JSON.stringify(listed.body).includes("keyDigest"))
})

test("channel keys are sealed before they reach storage", async () => {
	const world = await fresh()
	const secret = "sk-upstream-plaintext-credential"
	const { status } = await call("channels", {
		method: "POST",
		headers: bearer(world.adminKey),
		body: {
			name: "primary",
			type: "openai",
			baseUrl: "https://api.example.com",
			models: ["gpt-4o"],
			keys: [secret],
		},
	})
	assert.equal(status, 201)

	const stored = await (await channelKeys()).find({})
	assert.equal(stored.length, 1)
	assert.ok(!JSON.stringify(stored[0]).includes(secret))

	// And the audit row for the create must not have kept it either.
	const rows = await (await auditLogs()).find({})
	assert.ok(!JSON.stringify(rows).includes(secret))
})

test("a credential-bearing header cannot be pinned to a channel", async () => {
	const world = await fresh()
	const { status } = await call("channels", {
		method: "POST",
		headers: bearer(world.adminKey),
		body: {
			name: "sneaky",
			type: "openai",
			baseUrl: "https://api.example.com",
			keys: ["sk-x"],
			headers: { Authorization: "Bearer sk-someone-elses" },
		},
	})
	assert.equal(status, 400)
})

test("mutations are audited", async () => {
	const world = await fresh()
	await call("users", {
		method: "POST",
		headers: bearer(world.adminKey),
		body: { username: "audited" },
	})
	const rows = await (await auditLogs()).find({})
	const created = rows.find((row) => row.action === "user.create")
	assert.ok(created)
	assert.equal(created.actorId, world.admin._id)
	assert.equal(created.actorRole, "root")
	assert.ok(created.ipHash)
	// Hashed, not raw (GW-024).
	assert.ok(!created.ipHash.includes("203.0.113.9"))
})

test("an unknown admin route is a 404", async () => {
	const world = await fresh()
	const { status } = await call("nonsense", { headers: bearer(world.adminKey) })
	assert.equal(status, 404)
})

test("a redemption code can only be spent once", async () => {
	const world = await fresh()
	const batch = await createRedemptionBatch({
		count: 1,
		quota: 5000,
		createdBy: world.admin._id,
	})
	const code = batch.codes[0]

	const first = await redeemCode(code, world.member._id)
	assert.equal(first.quota, 5000)
	assert.equal(first.balance, 5100)

	await assert.rejects(redeemCode(code, world.member._id), /not valid/i)

	const user = await (await users()).findOne({ _id: world.member._id })
	assert.equal(user?.quota, 5100)
})

test("redemption codes are stored as digests", async () => {
	const world = await fresh()
	const batch = await createRedemptionBatch({
		count: 2,
		quota: 10,
		createdBy: world.admin._id,
	})
	const listed = await call("redemption", { headers: bearer(world.adminKey) })
	const serialized = JSON.stringify(listed.body)
	for (const code of batch.codes) {
		assert.ok(!serialized.includes(code), "a plaintext code was listed back")
	}
	assert.ok(!serialized.includes("codeDigest"))
})

test("an ordinary user may redeem but may not administer", async () => {
	const world = await fresh()
	const batch = await createRedemptionBatch({
		count: 1,
		quota: 42,
		createdBy: world.admin._id,
	})
	const redeemed = await call("redeem", {
		method: "POST",
		headers: bearer(world.memberKey),
		body: { code: batch.codes[0] },
	})
	assert.equal(redeemed.status, 200)
	assert.equal(redeemed.body.quota, 42)

	const refused = await call("channels", { headers: bearer(world.memberKey) })
	assert.equal(refused.status, 403)
})

test("sign-in failures are indistinguishable", async () => {
	const world = await fresh()
	const credentials = await hashPassword("correct horse battery staple")
	await (await users()).updateOne({ _id: world.admin._id }, { $set: credentials })

	async function attempt(username: string, password: string) {
		const req = new Request("https://gateway.test/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username, password }),
		})
		const response = await handleAuthRequest(req, ["login"])
		return { status: response.status, text: await response.text() }
	}

	const unknown = await attempt("nobody", "whatever-long-enough")
	const wrong = await attempt("root", "wrong-but-long-enough")
	assert.equal(unknown.status, 403)
	assert.equal(wrong.status, 403)
	// Same message for both: no oracle for whether the account exists.
	assert.equal(messageOf(unknown.text), messageOf(wrong.text))
	assert.match(messageOf(wrong.text), /not valid/i)
})

test("a correct sign-in issues both cookies", async () => {
	const world = await fresh()
	const credentials = await hashPassword("correct horse battery staple")
	await (await users()).updateOne({ _id: world.admin._id }, { $set: credentials })

	const req = new Request("https://gateway.test/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: "root", password: "correct horse battery staple" }),
	})
	const response = await handleAuthRequest(req, ["login"])
	assert.equal(response.status, 200)

	const cookies = response.headers.getSetCookie()
	assert.equal(cookies.length, 2)
	assert.ok(
		cookies.some((cookie) => cookie.includes(SESSION_COOKIE) && cookie.includes("HttpOnly")),
	)

	const body = (await response.json()) as Record<string, unknown>
	// The password must not be echoed, and neither must anything derived from it.
	const serialized = JSON.stringify(body)
	assert.ok(!serialized.includes("correct horse"))
	assert.ok(!serialized.includes(credentials.passwordHash))
})

test("an open redirect cannot be smuggled through the OAuth return path", async () => {
	await fresh()
	const previous = {
		id: process.env.GITHUB_CLIENT_ID,
		secret: process.env.GITHUB_CLIENT_SECRET,
		base: process.env.PUBLIC_BASE_URL,
	}
	process.env.GITHUB_CLIENT_ID = "client-id"
	process.env.GITHUB_CLIENT_SECRET = "client-secret"
	process.env.PUBLIC_BASE_URL = "https://gateway.test"
	try {
		const req = new Request(
			"https://gateway.test/api/auth/github?redirect=" +
				encodeURIComponent("https://evil.example/steal"),
		)
		const response = await handleAuthRequest(req, ["github"])
		assert.equal(response.status, 302)
		const location = response.headers.get("location") ?? ""
		assert.ok(location.startsWith("https://github.com/login/oauth/authorize"))

		// The stored return path was rewritten to a local default.
		const stateId = new URL(location).searchParams.get("state") ?? ""
		assert.ok(stateId.length > 0)
		const state = await (await oauthStates()).findOne({ _id: stateId })
		assert.equal(state?.redirect, "/console")
	} finally {
		process.env.GITHUB_CLIENT_ID = previous.id
		process.env.GITHUB_CLIENT_SECRET = previous.secret
		process.env.PUBLIC_BASE_URL = previous.base
	}
})

test("a replayed OAuth state is refused", async () => {
	await fresh()
	const previous = {
		id: process.env.GITHUB_CLIENT_ID,
		secret: process.env.GITHUB_CLIENT_SECRET,
		base: process.env.PUBLIC_BASE_URL,
	}
	process.env.GITHUB_CLIENT_ID = "client-id"
	process.env.GITHUB_CLIENT_SECRET = "client-secret"
	process.env.PUBLIC_BASE_URL = "https://gateway.test"
	try {
		const response = await handleAuthRequest(
			new Request("https://gateway.test/api/auth/github/callback?code=abc&state=never-issued"),
			["github", "callback"],
		)
		// No network call is attempted: the state is checked first.
		assert.equal(response.status, 403)
	} finally {
		process.env.GITHUB_CLIENT_ID = previous.id
		process.env.GITHUB_CLIENT_SECRET = previous.secret
		process.env.PUBLIC_BASE_URL = previous.base
	}
})
