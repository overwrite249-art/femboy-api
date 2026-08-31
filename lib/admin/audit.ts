/**
 * The admin audit trail.
 *
 * Every privileged mutation writes one row here. The rows are meant to be
 * readable by a human during an incident, which means two things:
 *
 *  - `meta` must never contain a credential. Admin handlers pass whole request
 *    bodies in for context, and those bodies contain channel keys, so we scrub
 *    before storing rather than trusting each call site (GW-023).
 *  - a failed audit write must not take down the operation it describes, or a
 *    database hiccup during an incident would also block the fix.
 */

import { auditLogs } from "../db/index.ts"
import type { UserRole } from "../db/types.ts"
import { randomHex } from "../util/crypto.ts"

export type AuditEntry = {
	actorId: string
	actorRole: UserRole
	action: string
	targetType: string
	targetId: string
	meta?: Record<string, unknown>
	ipHash: string
}

/** Keys whose values are never safe to persist, matched case-insensitively. */
const SENSITIVE = /key|secret|token|password|passwd|cipher|credential|authorization|cookie|digest/i

const MAX_STRING = 200
const MAX_DEPTH = 4
const MAX_KEYS = 40

export function scrubMeta(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return null
	if (typeof value === "string") {
		return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "..." : value
	}
	if (typeof value === "number" || typeof value === "boolean") return value
	if (value instanceof Date) return value.toISOString()
	if (depth >= MAX_DEPTH) return "[truncated]"
	if (Array.isArray(value)) {
		return value.slice(0, MAX_KEYS).map((item) => scrubMeta(item, depth + 1))
	}
	if (typeof value !== "object") return String(value)

	const out: Record<string, unknown> = {}
	let seen = 0
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (seen >= MAX_KEYS) break
		seen += 1
		if (SENSITIVE.test(key)) {
			// Record that a field was supplied, never what it was.
			out[key] = item === undefined || item === null ? null : "[redacted]"
			continue
		}
		out[key] = scrubMeta(item, depth + 1)
	}
	return out
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
	try {
		const collection = await auditLogs()
		await collection.insertOne({
			_id: randomHex(12),
			actorId: entry.actorId,
			actorRole: entry.actorRole,
			action: entry.action,
			targetType: entry.targetType,
			targetId: entry.targetId,
			meta: scrubMeta(entry.meta ?? {}) as Record<string, unknown>,
			ipHash: entry.ipHash,
			createdAt: new Date(),
		})
	} catch {
		// Deliberately swallowed: see the note at the top of this file.
	}
}
