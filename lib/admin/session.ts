/**
 * Console sessions.
 *
 * The console is a first-party UI, so it authenticates with a signed cookie
 * rather than an API key. Two rules matter more here than anything else:
 *
 *  1. A session must never be usable as a relay credential, and a relay key
 *     must never be usable as a console session. They are separate authorities
 *     with separate blast radii (GW-018).
 *  2. Cookie authentication is *ambient* -- the browser attaches it whether or
 *     not the user meant to make the request. So every state-changing console
 *     call needs a proof that a cross-site page could not have produced.
 *
 * The CSRF token is derived as HMAC(secret, "csrf:" + sid) rather than being
 * stored. That keeps it stateless, but note that it is NOT derivable by a
 * client: the session id is visible inside the cookie, but without the server
 * secret the matching token cannot be computed.
 */

import { config, isProduction } from "../config/env.ts"
import type { UserDoc, UserRole } from "../db/types.ts"
import { ErrorCode, GatewayError } from "../http/errors.ts"
import {
	hmacSha256Hex,
	randomHex,
	signToken,
	timingSafeEqualHex,
	verifyToken,
} from "../util/crypto.ts"
import { nowSec } from "../util/time.ts"

export const SESSION_COOKIE = "fb_session"
export const CSRF_COOKIE = "fb_csrf"
export const CSRF_HEADER = "x-csrf-token"
export const SESSION_TTL_SEC = 12 * 60 * 60

export type SessionPayload = {
	/** User id. */
	sub: string
	username: string
	role: UserRole
	/** Session id: the seed for this session's CSRF token. */
	sid: string
	exp: number
}

function sessionSecret(): string {
	const secret = config.sessionSecret
	if (!secret) {
		// Fail closed. A blank secret would make every forged cookie valid.
		throw new GatewayError({
			code: ErrorCode.CONFIGURATION_ERROR,
			status: 503,
			message: "SESSION_SECRET is not configured",
		})
	}
	return secret
}

function secureCookies(): boolean {
	return isProduction() || config.publicBaseUrl.startsWith("https://")
}

/** Reads one cookie without trusting the header to be well formed. */
export function readCookie(req: Request, name: string): string {
	const header = req.headers.get("cookie")
	if (!header) return ""
	for (const part of header.split(";")) {
		const eq = part.indexOf("=")
		if (eq <= 0) continue
		if (part.slice(0, eq).trim() !== name) continue
		try {
			return decodeURIComponent(part.slice(eq + 1).trim())
		} catch {
			return ""
		}
	}
	return ""
}

export async function csrfTokenFor(sid: string): Promise<string> {
	return await hmacSha256Hex(sessionSecret(), "csrf:" + sid)
}

export async function createSession(
	user: UserDoc,
): Promise<{ token: string; csrf: string; payload: SessionPayload }> {
	const sid = randomHex(16)
	const payload: SessionPayload = {
		sub: user._id,
		username: user.username,
		role: user.role,
		sid,
		exp: nowSec() + SESSION_TTL_SEC,
	}
	return {
		token: await signToken(payload, sessionSecret()),
		csrf: await csrfTokenFor(sid),
		payload,
	}
}

/** Returns the session carried by this request, or null. Never throws on a bad cookie. */
export async function readSession(req: Request): Promise<SessionPayload | null> {
	const raw = readCookie(req, SESSION_COOKIE)
	if (!raw) return null
	try {
		return await verifyToken<SessionPayload>(raw, sessionSecret())
	} catch {
		return null
	}
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Verifies a state-changing console request was intended by the user.
 *
 * The token must arrive in a *header*. A cross-site form post can make the
 * browser send our cookies, but it cannot set a custom header, so we
 * deliberately do not accept the cookie copy as proof of itself.
 */
export async function assertCsrf(req: Request, session: SessionPayload): Promise<void> {
	if (SAFE_METHODS.has(req.method.toUpperCase())) return

	const origin = req.headers.get("origin")
	if (origin && config.publicBaseUrl && !config.publicBaseUrl.startsWith(origin)) {
		throw new GatewayError({
			code: ErrorCode.INSUFFICIENT_PERMISSIONS,
			status: 403,
			message: "request origin is not allowed",
		})
	}

	const presented = req.headers.get(CSRF_HEADER) ?? ""
	const expected = await csrfTokenFor(session.sid)
	if (!presented || !timingSafeEqualHex(presented, expected)) {
		throw new GatewayError({
			code: ErrorCode.INSUFFICIENT_PERMISSIONS,
			status: 403,
			message: "missing or invalid CSRF token",
		})
	}
}

function cookie(name: string, value: string, maxAgeSec: number, httpOnly: boolean): string {
	const parts = [
		name + "=" + encodeURIComponent(value),
		"Path=/",
		"SameSite=Lax",
		"Max-Age=" + String(Math.max(0, Math.floor(maxAgeSec))),
	]
	if (httpOnly) parts.push("HttpOnly")
	if (secureCookies()) parts.push("Secure")
	return parts.join("; ")
}

/**
 * The cookies to set on a successful sign-in. The session cookie is HttpOnly
 * so script cannot exfiltrate it; the CSRF cookie deliberately is not, because
 * the console's own script has to read it to echo it back in a header.
 */
export function sessionCookies(token: string, csrf: string): string[] {
	return [
		cookie(SESSION_COOKIE, token, SESSION_TTL_SEC, true),
		cookie(CSRF_COOKIE, csrf, SESSION_TTL_SEC, false),
	]
}

export function clearedSessionCookies(): string[] {
	return [cookie(SESSION_COOKIE, "", 0, true), cookie(CSRF_COOKIE, "", 0, false)]
}

/** Attaches cookies to a response without clobbering an existing Set-Cookie. */
export function withCookies(response: Response, cookies: string[]): Response {
	const headers = new Headers(response.headers)
	for (const value of cookies) headers.append("set-cookie", value)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
