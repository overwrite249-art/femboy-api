/**
 * The gate in front of everything under /api/admin.
 *
 * Four checks, in this order, and the order matters:
 *
 *  1. Network fence. If the operator has restricted the console to a set of
 *     CIDRs, a valid credential presented from outside them is still refused.
 *     Cheapest check first, and it holds even if a credential leaks.
 *  2. Identity. Either a console session cookie or an API key. Both are
 *     accepted, but they are separate authorities: a session cannot relay, and
 *     a key does not get a session's CSRF exemption.
 *  3. Intent. Cookie auth is ambient, so a state-changing call needs a CSRF
 *     token the browser could not have been tricked into sending.
 *  4. Authority. The role is re-read from the database, not taken from the
 *     cookie, so demoting or disabling an account takes effect immediately
 *     rather than whenever the session expires.
 */

import { assertRole, authenticate } from "../auth/authenticate.ts"
import { matchesAnyCidr } from "../auth/cidr.ts"
import { config } from "../config/env.ts"
import { users } from "../db/index.ts"
import type { UserRole } from "../db/types.ts"
import { forbidden, invalidRequest } from "../http/errors.ts"
import { getClientIp } from "../http/headers.ts"
import { hashIp } from "../http/redact.ts"
import { asRecord, readLimitedText, safeJsonParse } from "../util/json.ts"
import { randomHex } from "../util/crypto.ts"
import { assertCsrf, readSession } from "./session.ts"

export type AdminContext = {
	userId: string
	username: string
	role: UserRole
	clientIp: string
	ipHash: string
	requestId: string
	via: "session" | "key"
}

const ROLE_RANK: Record<UserRole, number> = { user: 0, admin: 1, root: 2 }

/** Admin bodies are small by nature; this is far below the relay's ceiling. */
const MAX_ADMIN_BODY_BYTES = 512 * 1024

export async function requireAdmin(
	req: Request,
	minimum: UserRole = "admin",
): Promise<AdminContext> {
	const clientIp = getClientIp(req.headers)
	const ipHash = await hashIp(clientIp)

	const fence = config.adminAllowedCidrs
	if (fence.length > 0 && !matchesAnyCidr(fence, clientIp)) {
		throw forbidden("admin access is not permitted from this address")
	}

	const session = await readSession(req)
	if (session) {
		await assertCsrf(req, session)

		const user = await (await users()).findOne({ _id: session.sub })
		if (!user || user.status !== "enabled") {
			throw forbidden("this account is not active")
		}
		if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) {
			throw forbidden("this operation requires elevated privileges")
		}
		return {
			userId: user._id,
			username: user.username,
			role: user.role,
			clientIp,
			ipHash,
			requestId: randomHex(8),
			via: "session",
		}
	}

	// No session: fall back to an API key. `authenticate` already applies key
	// state, expiry, the IP allowlist, and the constant-time floor, so those
	// checks are inherited rather than reimplemented here.
	const context = await authenticate(req)
	assertRole(context.identity, minimum)
	return {
		userId: context.identity.userId,
		username: context.identity.username,
		role: context.identity.role,
		clientIp: context.clientIp,
		ipHash: context.ipHash,
		requestId: context.requestId,
		via: "key",
	}
}

/** Reads and validates a JSON admin body. An empty body is an empty object. */
export async function readAdminBody(req: Request): Promise<Record<string, unknown>> {
	if (req.method === "GET" || req.method === "HEAD") return {}
	const text = await readLimitedText(req.body, MAX_ADMIN_BODY_BYTES)
	if (!text.trim()) return {}
	const parsed = safeJsonParse<unknown>(text)
	const record = asRecord(parsed)
	if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return record
	throw invalidRequest("request body must be a JSON object")
}

/** Parses `?limit=&skip=` without trusting either value. */
export function pagination(url: URL): { limit: number; skip: number } {
	const limit = Number(url.searchParams.get("limit") ?? "50")
	const skip = Number(url.searchParams.get("skip") ?? "0")
	return {
		limit: Number.isFinite(limit) ? limit : 50,
		skip: Number.isFinite(skip) ? skip : 0,
	}
}
