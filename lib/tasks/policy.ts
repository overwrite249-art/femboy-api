/** Task routes must not become an arbitrary provider-admin API proxy. */
import type { ChannelDoc, TaskDoc } from "../db/types.ts"
import { forbidden, invalidRequest } from "../http/errors.ts"
import { asRecord, safeJsonParse } from "../util/json.ts"
import { requireTask, type TaskActor } from "./index.ts"

const DEFAULT_PATHS: Record<string, string[]> = {
	midjourney: ["/mj/submit/imagine", "/mj/submit/blend", "/mj/submit/describe"],
	video: ["/v1/videos"],
}
const REFERENCES = new Set([
	"taskid", "jobid", "origintaskid", "sourcetaskid", "referencetaskid",
	"conversationid", "sessionid", "audioid", "clipid",
])

export function isTaskSubmitPathAllowed(channel: ChannelDoc, platform: string, path: string): boolean {
	if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return false
	const configured = channel.config?.submitPaths
	const paths = Array.isArray(configured) ? configured : DEFAULT_PATHS[platform] ?? []
	return paths.some((allowed) => typeof allowed === "string" && allowed === path)
}

/** Translate only gateway-owned task references, never raw provider identifiers. */
export async function prepareTaskBody(
	bytes: Uint8Array, contentType: string, actor: TaskActor, platform: string,
): Promise<{ bytes: Uint8Array; channelId?: string; channelKeyId?: string }> {
	if (!contentType.toLowerCase().includes("application/json")) {
		// Multipart fields can hide task references too. Unsupported shapes
		// must not bypass the ownership parser.
		throw invalidRequest("task submissions currently require application/json")
	}
	const parsed = safeJsonParse<unknown>(new TextDecoder().decode(bytes))
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidRequest("task body must be an object")
	const body = asRecord(parsed)
	const fields: Array<{ parent: Record<string, unknown>; key: string; id: string }> = []
	function walk(value: unknown): void {
		if (Array.isArray(value)) { for (const item of value) walk(item); return }
		if (!value || typeof value !== "object") return
		for (const [key, child] of Object.entries(value)) {
			if (REFERENCES.has(key.replace(/_/g, "").toLowerCase()) && child !== null && child !== "") {
				if (typeof child !== "string") throw invalidRequest("task references must be gateway task ids")
				fields.push({ parent: value as Record<string, unknown>, key, id: child })
				if (fields.length > 32) throw invalidRequest("too many task references")
			} else walk(child)
		}
	}
	walk(body)
	let channelId: string | undefined
	let channelKeyId: string | undefined
	const resolved = new Map<string, TaskDoc>()
	for (const field of fields) {
		let task = resolved.get(field.id)
		if (!task) {
			task = await requireTask(field.id, actor)
			resolved.set(field.id, task)
		}
		if (task.platform !== platform || !task.upstreamTaskId) throw forbidden("task is not a valid reference for this platform")
		if (channelId && channelId !== task.channelId) throw forbidden("task references must belong to the same channel")
		if (channelKeyId && channelKeyId !== task.channelKeyId) throw forbidden("task references must use the same provider account")
		channelId = task.channelId
		channelKeyId = task.channelKeyId
		field.parent[field.key] = task.upstreamTaskId
	}
	return { bytes: new TextEncoder().encode(JSON.stringify(body)), channelId, channelKeyId }
}