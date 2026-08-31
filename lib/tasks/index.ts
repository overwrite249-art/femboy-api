/**
 * Asynchronous task tracking.
 *
 * Midjourney, Suno, Kling and the video providers do not answer a generation
 * request; they accept it and hand back a job id to poll. That creates a
 * problem the synchronous relay never has: an identifier that outlives the
 * request, is handed to a client, and can be used later to fetch a result.
 *
 * Finding GW-019 is about exactly that identifier. Providers hand out ids that
 * are short, sequential, or otherwise guessable, and a gateway that forwards
 * them verbatim lets one customer poll another customer's job by counting. So:
 *
 *   - The client only ever sees `taskId`, 28 alphanumeric characters of CSPRNG
 *     output (about 166 bits). It is not derived from anything.
 *   - The provider's own id lives in `upstreamTaskId` and is never serialised
 *     into a response.
 *   - Every fetch re-checks ownership against the caller's identity.
 *   - A task that belongs to someone else is reported as **absent**, not
 *     forbidden. "You may not see this" still confirms that it exists.
 *
 * Quota is settled at submit time rather than on completion. The provider bills
 * for accepting the job, and these platforms price per call rather than per
 * token, so charging once at submission is both simpler and correct. Tasks
 * therefore carry `quotaSettled: true` from creation; the field exists so a
 * future per-result price can be added without a migration.
 */

import { tasks } from "../db/index.ts"
import type { TaskDoc, TaskPlatform } from "../db/types.ts"
import { notFound } from "../http/errors.ts"
import { randomAlphanumeric, randomHex } from "../util/crypto.ts"

/** The narrow slice of an identity that ownership needs. */
export type TaskActor = { userId: string; role: string }

export const TERMINAL_STATUSES: Array<TaskDoc["status"]> = ["success", "failure", "expired"]

export function isTerminal(status: TaskDoc["status"]): boolean {
	return TERMINAL_STATUSES.includes(status)
}

/**
 * Backoff between polls. Front-loaded because most jobs finish quickly, then
 * widening so a slow queue does not cost a poll every few seconds for an hour.
 */
export const POLL_BACKOFF_MS = [3_000, 8_000, 15_000, 30_000, 60_000, 120_000]
export const MAX_POLL_COUNT = 240
export const TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const SCAN_LIMIT = 500

export function nextPollDelayMs(pollCount: number): number {
	const index = Math.min(Math.max(0, pollCount), POLL_BACKOFF_MS.length - 1)
	return POLL_BACKOFF_MS[index] ?? 120_000
}

export function newTaskId(): string {
	return "task-" + randomAlphanumeric(28)
}

export async function createTask(input: {
	platform: TaskPlatform
	action: string
	userId: string
	tokenId: string
	channelId: string
	model: string
	quota: number
	properties?: Record<string, unknown>
}): Promise<TaskDoc> {
	const now = new Date()
	const doc: TaskDoc = {
		_id: randomHex(12),
		taskId: newTaskId(),
		platform: input.platform,
		action: input.action,
		userId: input.userId,
		tokenId: input.tokenId,
		channelId: input.channelId,
		model: input.model,
		status: "pending",
		progress: "0%",
		quota: input.quota,
		quotaSettled: true,
		submitTime: now,
		pollCount: 0,
		nextPollAt: new Date(now.getTime() + nextPollDelayMs(0)),
		// Never the prompt. Shape only (GW-023).
		properties: input.properties ?? {},
	}
	await tasks().insertOne(doc)
	return doc
}

export async function findTask(taskId: string): Promise<TaskDoc | null> {
	if (!taskId) return null
	return await tasks().findOne({ taskId })
}

export async function requireTask(taskId: string, actor: TaskActor): Promise<TaskDoc> {
	const doc = await findTask(taskId)
	if (!doc) throw notFound("no such task")
	if (actor.role === "user" && doc.userId !== actor.userId) throw notFound("no such task")
	return doc
}

export async function listTasks(
	actor: TaskActor,
	options: { limit?: number; skip?: number } = {},
): Promise<TaskDoc[]> {
	const limit = Math.min(Math.max(1, options.limit ?? 50), 200)
	const filter: Record<string, unknown> = actor.role === "user" ? { userId: actor.userId } : {}
	return await tasks().find(filter, {
		sort: { submitTime: -1 },
		limit,
		skip: Math.max(0, options.skip ?? 0),
	})
}

export async function updateTask(taskId: string, patch: Partial<TaskDoc>): Promise<void> {
	await tasks().updateOne({ taskId }, { $set: patch as Record<string, unknown> })
}

export async function markSubmitted(taskId: string, upstreamTaskId: string): Promise<void> {
	await updateTask(taskId, {
		upstreamTaskId,
		status: "submitted",
		startTime: new Date(),
		nextPollAt: new Date(Date.now() + nextPollDelayMs(0)),
	})
}

/**
 * Tasks ready for another poll.
 *
 * Scanned and filtered in process rather than with a range query, so the
 * in-memory twin behaves identically to Mongo. The collection is bounded by the
 * 24 hour expiry; an index-backed range query is a later optimisation and would
 * change nothing about the result.
 */
export async function dueTasks(limit = 50): Promise<TaskDoc[]> {
	const rows = await tasks().find({}, { sort: { submitTime: 1 }, limit: SCAN_LIMIT })
	const now = Date.now()
	const due: TaskDoc[] = []
	for (const row of rows) {
		if (isTerminal(row.status)) continue
		const at = row.nextPollAt ? new Date(row.nextPollAt).getTime() : 0
		if (at > now) continue
		due.push(row)
		if (due.length >= limit) break
	}
	return due
}

export function isExpired(doc: TaskDoc, now = Date.now()): boolean {
	if (doc.pollCount > MAX_POLL_COUNT) return true
	return now - new Date(doc.submitTime).getTime() > TASK_MAX_AGE_MS
}

/** The client-facing view. Deliberately omits every internal identifier. */
export function publicTask(doc: TaskDoc): Record<string, unknown> {
	return {
		id: doc.taskId,
		object: "task",
		platform: doc.platform,
		action: doc.action,
		model: doc.model,
		status: doc.status,
		progress: doc.progress,
		quota: doc.quota,
		submitTime: new Date(doc.submitTime).toISOString(),
		startTime: doc.startTime ? new Date(doc.startTime).toISOString() : null,
		finishTime: doc.finishTime ? new Date(doc.finishTime).toISOString() : null,
		result: doc.result ?? null,
		failReason: doc.failReason ?? null,
	}
}

const MJ_STATUS: Record<string, string> = {
	pending: "NOT_START",
	submitted: "SUBMITTED",
	in_progress: "IN_PROGRESS",
	success: "SUCCESS",
	failure: "FAILURE",
	expired: "FAILURE",
}

/** Midjourney's own response shape, with our id substituted for theirs. */
export function mjTaskView(doc: TaskDoc): Record<string, unknown> {
	const result = doc.result ?? {}
	const imageUrl = typeof result.imageUrl === "string" ? result.imageUrl : ""
	return {
		id: doc.taskId,
		action: doc.action.toUpperCase(),
		status: MJ_STATUS[doc.status] ?? "NOT_START",
		progress: doc.progress,
		description: doc.failReason ?? "",
		submitTime: new Date(doc.submitTime).getTime(),
		startTime: doc.startTime ? new Date(doc.startTime).getTime() : 0,
		finishTime: doc.finishTime ? new Date(doc.finishTime).getTime() : 0,
		imageUrl,
		failReason: doc.failReason ?? "",
		properties: {},
	}
}

const ID_FIELDS = ["result", "task_id", "taskId", "id", "job_id", "jobId", "request_id"]

/** Finds whatever the provider called its job id, without trusting the shape. */
export function extractUpstreamTaskId(value: unknown, depth = 0): string {
	if (depth > 3 || !value || typeof value !== "object") return ""
	const record = value as Record<string, unknown>
	for (const field of ID_FIELDS) {
		const found = record[field]
		if (typeof found === "string" && found.length > 0) return found
		if (typeof found === "number" && Number.isFinite(found)) return String(found)
	}
	for (const nested of ["data", "result", "task", "output"]) {
		const child = record[nested]
		if (child && typeof child === "object") {
			const found = extractUpstreamTaskId(child, depth + 1)
			if (found) return found
		}
	}
	return ""
}

/**
 * Replaces every echo of the provider's id with ours, wherever it appears.
 *
 * Providers repeat their id in several places, and missing one of them leaks a
 * pollable identifier. A bounded deep replacement is more reliable than a list
 * of known field names.
 */
export function rewriteTaskId(value: unknown, from: string, to: string, depth = 0): unknown {
	if (!from || depth > 5) return value
	if (typeof value === "string") return value === from ? to : value
	if (Array.isArray(value)) return value.map((item) => rewriteTaskId(item, from, to, depth + 1))
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = rewriteTaskId(item, from, to, depth + 1)
		}
		return out
	}
	return value
}
