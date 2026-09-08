/**
 * Sign-in surfaces for the console: password login, sign-out, and GitHub OAuth.
 *
 * These endpoints are the one place in the project that issues a session, so
 * they are also the one place that has to be careful about a few browser-only
 * hazards:
 *
 *  - **Open redirect.** `?redirect=` is attacker-controllable, so it is only
 *    ever accepted as a local path. Otherwise the OAuth flow becomes a way to
 *    bounce a victim off a trusted origin.
 *  - **Replayed callbacks.** The OAuth state row is deleted before the code is
 *    exchanged, so a second callback with the same state finds nothing.
 *  - **Password guessing.** Verification always performs a full PBKDF2
 *    derivation, even for an unknown user, so response time does not reveal
 *    whether an account exists. A per-address attempt cap sits on top.
 *  - **Account takeover by email.** A GitHub identity is linked by immutable
 *    numeric id, never by email or login name, both of which the account owner
 *    can change at will.
 */

import { config, assertProductionReady } from "../config/env.ts"
import { oauthStates, users } from "../db/index.ts"
import type { OAuthStateDoc, UserDoc } from "../db/types.ts"
import { ErrorCode, GatewayError, forbidden, invalidRequest } from "../http/errors.ts"
import { getClientIp } from "../http/headers.ts"
import { safeRedirect } from "../http/redirect.ts"
import { hashIp } from "../http/redact.ts"
import { errorResponse, jsonResponse } from "../http/respond.ts"
import { enforceAttemptLimit } from "../ratelimit/index.ts"
import { randomHex, timingSafeEqualHex } from "../util/crypto.ts"
import { asRecord, readLimitedText, safeJsonParse } from "../util/json.ts"
import { recordAudit } from "./audit.ts"
import { assertPasswordAcceptable, hashPassword, needsPasswordUpgrade, verifyPassword } from "./password.ts"
import {
	clearedSessionCookies,
	assertCsrf,
	createSession,
	oauthStateCookie,
	OAUTH_STATE_COOKIE,
	readCookie,
	readSession,
	revokeSession,
	sessionCookies,
	withCookies,
} from "./session.ts"
import { createUser, findUserByUsername } from "./store.ts"

const MAX_LOGIN_ATTEMPTS = 10
const ATTEMPT_WINDOW_SEC = 900
const STATE_TTL_MS = 10 * 60 * 1000
const OAUTH_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 64 * 1024

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token"
const GITHUB_USER = "https://api.github.com/user"

/** Advisory counter, keyed by hashed address. Not a substitute for a slow hash. */
function attemptKey(ipHash: string): string {
	return `login:att:${ipHash}`
}

function configurationError(message: string): GatewayError {
	return new GatewayError({
		code: ErrorCode.CONFIGURATION_ERROR,
		status: 503,
		message,
	})
}

function redirectTo(location: string, cookies: string[] = []): Response {
	const response = new Response(null, { status: 302, headers: { location } })
	return cookies.length > 0 ? withCookies(response, cookies) : response
}

function publicUser(user: UserDoc): Record<string, unknown> {
	return {
		id: user._id,
		username: user.username,
		displayName: user.displayName,
		email: user.email,
		role: user.role,
		group: user.group,
		quota: user.quota,
		usedQuota: user.usedQuota,
		requestCount: user.requestCount,
	}
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
	if (req.method === "GET" || req.method === "HEAD") return {}
	const text = await readLimitedText(req.body, MAX_BODY_BYTES)
	if (!text.trim()) return {}
	return asRecord(safeJsonParse<unknown>(text))
}

// ---------------------------------------------------------------------------
// Password login
// ---------------------------------------------------------------------------

async function login(req: Request): Promise<Response> {
	const body = await readBody(req)
	const username = String(body.username ?? "").trim()
	const password = String(body.password ?? "")
	const ipHash = await hashIp(getClientIp(req.headers))

	if (!username || !password) throw invalidRequest("username and password are required")

	const key = attemptKey(ipHash)
	await enforceAttemptLimit(key, MAX_LOGIN_ATTEMPTS, ATTEMPT_WINDOW_SEC,
		"too many sign-in attempts, try again later")

	const user = await (await users()).findOne({ username })
	// Verify against whatever we have, including nothing: verifyPassword still
	// runs a derivation when the record is absent, so a missing account and a
	// wrong password cost the same.
	const matched = await verifyPassword(password, user ?? {})

	if (!user || !matched || user.status !== "enabled") {
		await recordAudit({
			actorId: user?._id ?? "unknown",
			actorRole: user?.role ?? "user",
			action: "auth.login.failed",
			targetType: "user",
			targetId: username,
			ipHash,
		})
		// One message for every failure mode.
		throw forbidden("those credentials are not valid")
	}

	if (needsPasswordUpgrade(user)) {
		const upgraded = await hashPassword(password)
		// Never overwrite a credential changed concurrently by another operation.
		await (await users()).updateOne(
			{ _id: user._id, passwordHash: user.passwordHash, passwordSalt: user.passwordSalt },
			{ $set: upgraded },
		)
	}
	const session = await createSession(user)
	await (await users()).updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })
	await recordAudit({
		actorId: user._id,
		actorRole: user.role,
		action: "auth.login",
		targetType: "user",
		targetId: user._id,
		ipHash,
	})

	return withCookies(
		jsonResponse({ user: publicUser(user), csrf: session.csrf }, {}),
		sessionCookies(session.token, session.csrf),
	)
}

async function register(req: Request): Promise<Response> {
	if (!config.registrationEnabled) {
		throw forbidden("self-registration is disabled on this deployment")
	}
	const body = await readBody(req)
	const ipHash = await hashIp(getClientIp(req.headers))
	await enforceAttemptLimit(`register:att:${ipHash}`, 5, ATTEMPT_WINDOW_SEC,
		"too many registration attempts, try again later")
	const password = assertPasswordAcceptable(body.password)
	const credentials = await hashPassword(password)
	// Public input is an allowlist, never a control-plane object with one field
	// overridden. Quota, groups, status and future authority fields stay private.
	const user = await createUser({
		username: body.username,
		displayName: body.displayName,
		email: body.email,
		role: "user",
	}, credentials)

	const session = await createSession(user)
	return withCookies(
		jsonResponse({ user: publicUser(user), csrf: session.csrf }, { status: 201 }),
		sessionCookies(session.token, session.csrf),
	)
}

async function logout(req: Request): Promise<Response> {
	const session = await readSession(req)
	if (session) {
		await assertCsrf(req, session)
		await revokeSession(session)
		await recordAudit({
			actorId: session.sub,
			actorRole: session.role,
			action: "auth.logout",
			targetType: "user",
			targetId: session.sub,
			ipHash: await hashIp(getClientIp(req.headers)),
		})
	}
	// Unconditionally clear: signing out must work even from a stale cookie.
	return withCookies(jsonResponse({ signedOut: true }, {}), clearedSessionCookies())
}

async function currentSession(req: Request): Promise<Response> {
	const session = await readSession(req)
	if (!session) return jsonResponse({ user: null }, {})
	const user = await (await users()).findOne({ _id: session.sub })
	if (!user || user.status !== "enabled") {
		return withCookies(jsonResponse({ user: null }, {}), clearedSessionCookies())
	}
	return jsonResponse({ user: publicUser(user) }, {})
}

// ---------------------------------------------------------------------------
// GitHub OAuth
// ---------------------------------------------------------------------------

function githubConfigured(): void {
	if (!config.githubClientId || !config.githubClientSecret) {
		throw configurationError("GitHub sign-in is not configured")
	}
	if (!config.publicBaseUrl) {
		throw configurationError("PUBLIC_BASE_URL must be set for OAuth callbacks")
	}
}

async function githubStart(req: Request): Promise<Response> {
	githubConfigured()
	const ipHash = await hashIp(getClientIp(req.headers))
	await enforceAttemptLimit(`oauth:att:${ipHash}`, 20, ATTEMPT_WINDOW_SEC,
		"too many sign-in attempts, try again later")
	const url = new URL(req.url)
	const state: OAuthStateDoc = {
		_id: randomHex(16),
		provider: "github",
		redirect: safeRedirect(url.searchParams.get("redirect")),
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + STATE_TTL_MS),
	}
	await (await oauthStates()).insertOne(state)

	const authorize = new URL(GITHUB_AUTHORIZE)
	authorize.searchParams.set("client_id", config.githubClientId)
	authorize.searchParams.set("redirect_uri", `${config.publicBaseUrl}/api/auth/github/callback`)
	authorize.searchParams.set("scope", "read:user user:email")
	authorize.searchParams.set("state", state._id)
	authorize.searchParams.set("allow_signup", "false")
	return redirectTo(authorize.toString(), [oauthStateCookie(state._id, STATE_TTL_MS / 1000)])
}

async function exchangeCode(code: string): Promise<string> {
	const response = await fetch(GITHUB_TOKEN, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({
			client_id: config.githubClientId,
			client_secret: config.githubClientSecret,
			code,
			redirect_uri: `${config.publicBaseUrl}/api/auth/github/callback`,
		}),
		signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
	})
	const text = await response.text()
	const parsed = asRecord(safeJsonParse<unknown>(text))
	const token = typeof parsed.access_token === "string" ? parsed.access_token : ""
	if (!token) throw forbidden("GitHub did not return an access token")
	return token
}

async function fetchGithubUser(token: string): Promise<{ id: string; login: string; email: string; name: string }> {
	const response = await fetch(GITHUB_USER, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"user-agent": "femboy-api",
		},
		signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
	})
	if (!response.ok) throw forbidden("GitHub rejected the profile request")
	const profile = asRecord(safeJsonParse<unknown>(await response.text()))
	const id = profile.id === undefined || profile.id === null ? "" : String(profile.id)
	if (!id) throw forbidden("GitHub profile had no id")
	return {
		id,
		login: typeof profile.login === "string" ? profile.login : `gh-${id}`,
		email: typeof profile.email === "string" ? profile.email : "",
		name: typeof profile.name === "string" ? profile.name : "",
	}
}

async function githubCallback(req: Request): Promise<Response> {
	githubConfigured()
	const url = new URL(req.url)
	const code = url.searchParams.get("code") ?? ""
	const stateId = url.searchParams.get("state") ?? ""
	if (!code || !stateId) throw invalidRequest("missing code or state")
	const browserState = readCookie(req, OAUTH_STATE_COOKIE)
	if (!/^[a-f0-9]{32}$/.test(stateId) || !timingSafeEqualHex(stateId, browserState)) {
		throw forbidden("that sign-in attempt is no longer valid")
	}

	const states = await oauthStates()
	// Claim atomically. Separate find/delete calls let concurrent callbacks both
	// exchange the code. Expiry is in the predicate, not a post-claim check.
	const state = await states.findOneAndUpdate(
		{ _id: stateId, consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
		{ $set: { consumedAt: new Date() } },
	)
	if (!state) throw forbidden("that sign-in attempt is no longer valid")

	const profile = await fetchGithubUser(await exchangeCode(code))
	const collection = await users()
	const ipHash = await hashIp(getClientIp(req.headers))

	// Linked by immutable numeric id, never by login or email.
	let user = await collection.findOne({ githubId: profile.id })
	if (!user) {
		if (!config.registrationEnabled) {
			throw forbidden("this GitHub account is not linked to a user")
		}
		let username = profile.login.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48) || `gh-${profile.id}`
		if (await findUserByUsername(username)) username = `${username}-${randomHex(3)}`
		const created = await createUser({
			username,
			displayName: profile.name || username,
			email: profile.email,
			role: "user",
		}, { githubId: profile.id })
		user = created
		await recordAudit({
			actorId: created._id,
			actorRole: "user",
			action: "auth.github.register",
			targetType: "user",
			targetId: created._id,
			ipHash,
		})
	}

	if (user.status !== "enabled") throw forbidden("this account is not active")

	const session = await createSession(user)
	await collection.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })
	await recordAudit({
		actorId: user._id,
		actorRole: user.role,
		action: "auth.github.login",
		targetType: "user",
		targetId: user._id,
		ipHash,
	})

	return redirectTo(safeRedirect(state.redirect), [
		...sessionCookies(session.token, session.csrf),
		oauthStateCookie("", 0),
	])
}

// ---------------------------------------------------------------------------

export async function handleAuthRequest(req: Request, segments: string[]): Promise<Response> {
	const method = req.method.toUpperCase()
	const [head = "", second = ""] = segments

	try {
		assertProductionReady()
		if (head === "login" && method === "POST") return await login(req)
		if (head === "register" && method === "POST") return await register(req)
		if (head === "logout" && method === "POST") return await logout(req)
		if (head === "session" && method === "GET") return await currentSession(req)
		if (head === "github" && !second && method === "GET") return await githubStart(req)
		if (head === "github" && second === "callback" && method === "GET") {
			return await githubCallback(req)
		}
		throw invalidRequest(`no auth route for ${method} /${segments.join("/")}`)
	} catch (error) {
		return errorResponse(error, "openai", {})
	}
}
