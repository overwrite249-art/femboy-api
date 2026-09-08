import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { pbkdf2Sync } from "node:crypto"
import { handleAuthRequest } from "../../lib/admin/login.ts"
import { handleAdminRequest } from "../../lib/admin/router.ts"
import { createUser, createToken, updateUser } from "../../lib/admin/store.ts"
import { createSession, assertCsrf, readSession, SESSION_COOKIE, CSRF_HEADER } from "../../lib/admin/session.ts"
import { authenticate } from "../../lib/auth/authenticate.ts"
import { safeRedirect } from "../../lib/http/redirect.ts"
import { setDb, users, oauthStates } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { GatewayError } from "../../lib/http/errors.ts"

const originalFetch = globalThis.fetch
const originalNow = Date.now
const environment = { ...process.env }

beforeEach(() => {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	Object.assign(process.env, { NODE_ENV: "test" })
	process.env.SESSION_SECRET = "hardening-session-fixture"
	process.env.KEY_PEPPER = "hardening-pepper-fixture"
	process.env.IP_HASH_SECRET = "hardening-ip-fixture"
	process.env.MIN_AUTH_LATENCY_MS = "0"
	process.env.PUBLIC_BASE_URL = "https://gateway.test"
	process.env.REGISTRATION_ENABLED = "true"
	process.env.GITHUB_CLIENT_ID = "fixture-client"
	process.env.GITHUB_CLIENT_SECRET = "fixture-secret"
	delete process.env.ADMIN_ALLOWED_CIDRS
})

afterEach(() => {
	globalThis.fetch = originalFetch
	Date.now = originalNow
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key]
	}
	Object.assign(process.env, environment)
})

function request(path: string, method = "POST", body?: unknown, headers: Record<string, string> = {}) {
	return new Request(`https://gateway.test/api/${path}`, {
		method,
		headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

async function admin(path: string, key: string, method = "GET", body?: unknown) {
	return handleAdminRequest(
		request(`admin/${path}`, method, body, { authorization: `Bearer ${key}` }),
		path.split("/"),
	)
}

async function account(role: "user" | "admin" | "root" = "user", username = role) {
	const user = await createUser({ username, role, quota: 10_000 })
	const { key, token } = await createToken({ userId: user._id, unlimitedQuota: true })
	return { user, key, token }
}

test("self-registration cannot assign money, routing groups, roles, or status", async () => {
	const response = await handleAuthRequest(request("auth/register", "POST", {
		username: "new-member",
		password: "a sufficiently long test password",
		role: "root",
		quota: 9_000_000,
		group: "privileged",
		status: "disabled",
	}), ["register"])
	assert.equal(response.status, 201)
	const user = await (await users()).findOne({ username: "new-member" })
	assert.equal(user?.role, "user")
	assert.equal(user?.quota, 0)
	assert.equal(user?.group, "default")
	assert.equal(user?.status, "enabled")
})

test("all administrator user responses omit stored password material", async () => {
	const root = await account("root")
	const member = await account("user")
	await (await users()).updateOne({ _id: member.user._id }, {
		$set: { passwordHash: "sensitive-derived-password", passwordSalt: "sensitive-password-salt" },
	})
	for (const [path, method, body] of [
		["users", "GET", undefined],
		[`users/${member.user._id}`, "GET", undefined],
		[`users/${member.user._id}`, "PATCH", { displayName: "Updated" }],
	] as const) {
		const response = await admin(path, root.key, method, body)
		assert.equal(response.status, 200)
		assert.doesNotMatch(await response.text(), /passwordHash|passwordSalt|sensitive-/)
	}
})

test("an admin cannot mint a root account or elevate themselves", async () => {
	const actor = await account("admin")
	for (const [path, body] of [
		["users", { username: "new-root", role: "root" }],
		[`users/${actor.user._id}`, { role: "root" }],
	] as const) {
		const response = await admin(path, actor.key, path === "users" ? "POST" : "PATCH", body)
		assert.equal(response.status, 403)
	}
	assert.equal(await (await users()).countDocuments({ role: "root" }), 0)
})

test("an admin cannot mint, rotate, edit, or delete a root's relay key", async () => {
	const root = await account("root")
	const actor = await account("admin")
	for (const [path, method, body] of [
		["tokens", "POST", { userId: root.user._id }],
		[`tokens/${root.token._id}/rotate`, "POST", {}],
		[`tokens/${root.token._id}`, "PATCH", { unlimitedQuota: true }],
		[`tokens/${root.token._id}`, "DELETE", undefined],
	] as const) {
		const response = await admin(path, actor.key, method, body)
		assert.equal(response.status, 403, `${method} ${path}`)
	}
})

test("root can still manage accounts and keys", async () => {
	const root = await account("root")
	const response = await admin("users", root.key, "POST", { username: "operator", role: "admin" })
	assert.equal(response.status, 201)
})

test("admin-key authorization rechecks the owner's current authority", async () => {
	const actor = await account("admin")
	assert.equal((await admin("users", actor.key)).status, 200)
	await (await users()).updateOne({ _id: actor.user._id }, { $set: { role: "user" } })
	assert.equal((await admin("users", actor.key)).status, 403)
})

test("a cached API key cannot outlive its expiry", async () => {
	const { user } = await account()
	const now = Date.now()
	const { key } = await createToken({ userId: user._id, expiresAt: new Date(now + 1000).toISOString() })
	const req = request("v1/models", "GET", undefined, { authorization: `Bearer ${key}` })
	await authenticate(req)
	Date.now = () => now + 2000
	await assert.rejects(authenticate(req), /invalid api key/i)
})

test("disabling an account invalidates keys beyond the first 200", async () => {
	const { user } = await account()
	let lastKey = ""
	for (let i = 0; i < 201; i++) {
		lastKey = (await createToken({ userId: user._id })).key
	}
	const req = request("v1/models", "GET", undefined, { authorization: `Bearer ${lastKey}` })
	await authenticate(req)
	await updateUser(user._id, { status: "disabled" })
	await assert.rejects(authenticate(req), /invalid api key/i)
})

test("concurrent password guesses consume the attempt budget atomically", async () => {
	const responses = await Promise.all(Array.from({ length: 20 }, () =>
		handleAuthRequest(request("auth/login", "POST", { username: "absent", password: "not-a-password" }), ["login"]),
	))
	const bodies = await Promise.all(responses.map((response) => response.text()))
	assert.equal(bodies.filter((body) => body.includes("those credentials are not valid")).length, 10)
	assert.equal(bodies.filter((body) => body.includes("too many sign-in attempts")).length, 10)
})

test("OAuth start binds state to an HttpOnly, short-lived browser cookie", async () => {
	const response = await handleAuthRequest(request("auth/github", "GET"), ["github"])
	assert.equal(response.status, 302)
	const cookies = response.headers.getSetCookie()
	assert.equal(cookies.length, 1)
	assert.match(cookies[0], /HttpOnly/)
	assert.match(cookies[0], /SameSite=Lax/)
	assert.match(cookies[0], /Secure/)
	assert.match(cookies[0], /Max-Age=600/)
})

test("a state issued to another browser cannot log the victim in", async () => {
	const start = await handleAuthRequest(request("auth/github", "GET"), ["github"])
	const state = new URL(start.headers.get("location")!).searchParams.get("state")!
	let calls = 0
	globalThis.fetch = async () => { calls++; throw new Error("network should not run") }
	const response = await handleAuthRequest(request(`auth/github/callback?state=${state}&code=fixture`, "GET"), ["github", "callback"])
	assert.equal(response.status, 403)
	assert.equal(calls, 0)
	assert.ok(await (await oauthStates()).findOne({ _id: state }), "foreign callbacks must not consume state")
})

test("only one simultaneous OAuth callback can exchange a code", async () => {
	const member = await account()
	await (await users()).updateOne({ _id: member.user._id }, { $set: { githubId: "123" } })
	const start = await handleAuthRequest(request("auth/github", "GET"), ["github"])
	const state = new URL(start.headers.get("location")!).searchParams.get("state")!
	const cookie = start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
	let exchanges = 0
	globalThis.fetch = async (url) => {
		if (String(url).includes("access_token")) {
			exchanges++
			return Response.json({ access_token: "fixture-oauth-token" })
		}
		return Response.json({ id: 123, login: "user" })
	}
	const responses = await Promise.all(Array.from({ length: 2 }, () =>
		handleAuthRequest(request(`auth/github/callback?state=${state}&code=fixture`, "GET", undefined, { cookie }), ["github", "callback"]),
	))
	assert.deepEqual(responses.map((r) => r.status).sort(), [302, 403])
	assert.equal(exchanges, 1)
})

test("OAuth return paths cannot contain URL-parser control characters", async () => {
	for (const redirect of ["/\t/evil.example", "/\r/evil.example", "/\\evil.example", "//evil.example"]) {
		const response = await handleAuthRequest(request(`auth/github?redirect=${encodeURIComponent(redirect)}`, "GET"), ["github"])
		const stateId = new URL(response.headers.get("location")!).searchParams.get("state")
		const state = await (await oauthStates()).findOne({ _id: stateId })
		assert.equal(state?.redirect, "/console", JSON.stringify(redirect))
	}
})

test("CSRF origin validation compares complete origins, not string prefixes", async () => {
	const { user } = await account("root")
	process.env.PUBLIC_BASE_URL = "https://example.com.gateway.test"
	const session = await createSession(user)
	await assert.rejects(assertCsrf(request("admin/users", "POST", {}, {
		origin: "https://example.com",
		[CSRF_HEADER]: session.csrf,
	}), session.payload), /origin is not allowed/)
})

test("logout requires CSRF proof when a session is present", async () => {
	const { user } = await account()
	const session = await createSession(user)
	const response = await handleAuthRequest(request("auth/logout", "POST", {}, {
		cookie: `${SESSION_COOKIE}=${session.token}`,
	}), ["logout"])
	assert.equal(response.status, 403)
})

test("a successful logout revokes a copied session, not just browser cookies", async () => {
	const { user } = await account()
	const session = await createSession(user)
	const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, [CSRF_HEADER]: session.csrf }
	const req = request("auth/logout", "POST", {}, headers)
	assert.ok(await readSession(req))
	assert.equal((await handleAuthRequest(req, ["logout"])).status, 200)
	assert.equal(await readSession(request("auth/session", "GET", undefined, headers)), null)
})

test("a successful login upgrades a legacy password hash without resetting the password", async () => {
	const { user } = await account()
	const password = "legacy-login-test-passphrase"
	const passwordSalt = "0123456789abcdef0123456789abcdef"
	await (await users()).updateOne({ _id: user._id }, { $set: {
		passwordSalt, passwordHash: pbkdf2Sync(password, passwordSalt, 210000, 32, "sha256").toString("hex"),
	} })
	const response = await handleAuthRequest(request("auth/login", "POST", { username: user.username, password }), ["login"])
	assert.equal(response.status, 200)
	assert.match((await (await users()).findOne({ _id: user._id }))!.passwordHash!, /^pbkdf2-sha256:600000:/)
})

test("logout cannot claim success when durable revocation cannot be checked", async () => {
	const { user } = await account()
	const session = await createSession(user)
	const broken = new MemoryDatabase()
	broken.collection = () => { throw new Error("injected database outage") }
	setDb(broken)
	const response = await handleAuthRequest(request("auth/logout", "POST", {}, {
		cookie: `${SESSION_COOKIE}=${session.token}`, [CSRF_HEADER]: session.csrf,
	}), ["logout"])
	assert.equal(response.status, 503)
	assert.equal(response.headers.has("set-cookie"), false)
})

test("the browser and OAuth share strict local redirect validation", () => {
	for (const input of ["//evil.example", "/\\evil.example", "/\t/evil.example", "\r/console", "javascript:alert(1)"]) {
		assert.equal(safeRedirect(input), "/console")
	}
	assert.equal(safeRedirect("/console/tokens?tab=active"), "/console/tokens?tab=active")
})

test("unexpected server errors do not disclose internal messages", () => {
	const error = GatewayError.from(new Error("connection failed: opaque-database-credential"))
	assert.equal(error.status, 500)
	assert.doesNotMatch(error.message, /opaque|connection failed/)
})

test("invalid JSON is a client error, not an internal server error", async () => {
	const req = new Request("https://gateway.test/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{not JSON",
	})
	const response = await handleAuthRequest(req, ["login"])
	assert.equal(response.status, 400)
})