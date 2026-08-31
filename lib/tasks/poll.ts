/**
 * Polling asynchronous jobs to completion.
 *
 * Runs from cron rather than from a request, because a client that disconnects
 * must not stop a job from being tracked, and because polling on the request
 * path would bill the caller for waiting.
 *
 * Every provider spells its status differently, and several spell it differently
 * from one endpoint to the next. Rather than a table per provider, the status is
 * resolved by matching whatever string the provider used against three word
 * lists. A word nobody recognises leaves the task in progress, which is the safe
 * default: the next poll will try again, and the 24 hour expiry is the backstop.
 */

import { config } from "../config/env.ts"
import { channels } from "../db/index.ts"
import type { ChannelDoc, TaskDoc } from "../db/types.ts"
import { buildUpstreamHeaders } from "../http/headers.ts"
import { pickChannelKey } from "../routing/keys.ts"
import { providerAuthHeaders } from "../transform/index.ts"
import { readCappedText, upstreamFetch } from "../upstream/fetch.ts"
import { dueTasks, isExpired, nextPollDelayMs, updateTask } from "./index.ts"

const SUCCESS_WORDS = [
	"success",
	"succeed",
	"succeeded",
	"completed",
	"complete",
	"finished",
	"done",
	"ok",
]

const FAILURE_WORDS = [
	"failure",
	"failed",
	"fail",
	"error",
	"canceled",
	"cancelled",
	"rejected",
	"banned",
]

const RUNNING_WORDS = [
	"in_progress",
	"inprogress",
	"in progress",
	"running",
	"processing",
	"generating",
	"started",
	"pending",
	"queued",
	"submitted",
	"not_start",
	"waiting",
]

function firstString(record: Record<string, unknown>, fields: string[]): string {
	for (const field of fields) {
		const value = record[field]
		if (typeof value === "string" && value.length > 0) return value
		if (typeof value === "number" && Number.isFinite(value)) return String(value)
	}
	return ""
}

function flatten(value: unknown, depth = 0): Record<string, unknown> {
	if (!value || typeof value !== "object" || depth > 3) return {}
	const record = value as Record<string, unknown>
	const out: Record<string, unknown> = { ...record }
	for (const nested of ["data", "result", "task", "output", "response"]) {
		const child = record[nested]
		if (child && typeof child === "object" && !Array.isArray(child)) {
			const inner = flatten(child, depth + 1)
			for (const [key, item] of Object.entries(inner)) {
				if (!(key in out)) out[key] = item
			}
		}
	}
	return out
}

export type Interpretation = {
	status: TaskDoc["status"]
	progress: string
	result?: Record<string, unknown>
	failReason?: string
}

export function interpretPollResult(payload: unknown): Interpretation {
	const flat = flatten(payload)
	const word = firstString(flat, ["status", "state", "task_status", "taskStatus"])
		.toLowerCase()
		.trim()
	const progressRaw = firstString(flat, ["progress", "percent", "percentage"])
	const progress = progressRaw
		? progressRaw.endsWith("%")
			? progressRaw
			: progressRaw + "%"
		: "0%"
	const failReason = firstString(flat, [
		"failReason",
		"fail_reason",
		"error",
		"error_message",
		"message",
	])

	if (FAILURE_WORDS.includes(word)) {
		return {
			status: "failure",
			progress,
			failReason: failReason || "the provider reported a failure",
		}
	}
	if (SUCCESS_WORDS.includes(word)) {
		return { status: "success", progress: "100%", result: flat }
	}
	if (RUNNING_WORDS.includes(word)) {
		return { status: "in_progress", progress }
	}
	// Some providers report only a percentage.
	if (progress === "100%") return { status: "success", progress, result: flat }
	return { status: "in_progress", progress }
}

/**
 * Where to ask about a job.
 *
 * A channel may override this with `config.pollPath`, using `__ID__` as the
 * placeholder, which is how an unrecognised provider is supported without a code
 * change.
 */
export function pollUrlFor(channel: ChannelDoc, task: TaskDoc): string {
	const base = channel.baseUrl.replace(/\/+$/, "")
	const id = encodeURIComponent(task.upstreamTaskId ?? "")
	const template = channel.config ? channel.config.pollPath : undefined
	if (typeof template === "string" && template.length > 0) {
		return base + template.replace("__ID__", id)
	}
	switch (String(task.platform)) {
		case "midjourney":
			return base + "/mj/task/" + id + "/fetch"
		case "suno":
			return base + "/api/v1/task/" + id
		case "kling":
			return base + "/v1/videos/generations/" + id
		case "vidu":
			return base + "/ent/v2/tasks/" + id + "/creations"
		case "jimeng":
			return base + "/v1/tasks/" + id
		case "dify":
			return base + "/v1/workflows/run/" + id
		default:
			return base + "/v1/tasks/" + id
	}
}

export async function pollDueTasks(limit = 50): Promise<Record<string, number>> {
	const due = await dueTasks(limit)
	let polled = 0
	let finished = 0
	let failed = 0
	let expired = 0
	let errors = 0

	for (const task of due) {
		polled += 1

		if (isExpired(task)) {
			await updateTask(task.taskId, {
				status: "expired",
				finishTime: new Date(),
				failReason: "the provider did not finish within the tracking window",
			})
			expired += 1
			continue
		}

		const nextCount = task.pollCount + 1

		try {
			if (!task.upstreamTaskId) {
				// Submitted but the provider never told us what to poll.
				await updateTask(task.taskId, {
					pollCount: nextCount,
					nextPollAt: new Date(Date.now() + nextPollDelayMs(nextCount)),
				})
				continue
			}

			const channel = await (await channels()).findOne({ _id: task.channelId })
			if (!channel) {
				await updateTask(task.taskId, {
					status: "failure",
					finishTime: new Date(),
					failReason: "the channel that accepted this job no longer exists",
				})
				failed += 1
				continue
			}

			const key = await pickChannelKey(channel._id)
			const headers = buildUpstreamHeaders({
				clientHeaders: new Headers(),
				authHeaders: providerAuthHeaders(channel.type, key.secret),
				channelHeaders: channel.headers,
			})

			const response = await upstreamFetch(
				pollUrlFor(channel, task),
				{ method: "GET", headers },
				{
					headerTimeoutMs: Math.min(config.upstreamHeaderTimeoutMs, 20_000),
					maxBytes: config.maxUpstreamResponseBytes,
				},
			)

			const text = await readCappedText(response).catch(() => "")
			if (!response.ok) {
				errors += 1
				await updateTask(task.taskId, {
					pollCount: nextCount,
					nextPollAt: new Date(Date.now() + nextPollDelayMs(nextCount)),
				})
				continue
			}

			let parsed: unknown = {}
			try {
				parsed = JSON.parse(text)
			} catch {
				parsed = {}
			}

			const verdict = interpretPollResult(parsed)
			const patch: Partial<TaskDoc> = {
				status: verdict.status,
				progress: verdict.progress,
				pollCount: nextCount,
			}
			if (verdict.status === "success") {
				patch.finishTime = new Date()
				patch.result = verdict.result ?? {}
				finished += 1
			} else if (verdict.status === "failure") {
				patch.finishTime = new Date()
				patch.failReason = verdict.failReason ?? "the provider reported a failure"
				failed += 1
			} else {
				patch.nextPollAt = new Date(Date.now() + nextPollDelayMs(nextCount))
			}

			await updateTask(task.taskId, patch)
		} catch {
			errors += 1
			await updateTask(task.taskId, {
				pollCount: nextCount,
				nextPollAt: new Date(Date.now() + nextPollDelayMs(nextCount)),
			}).catch(() => {})
		}
	}

	return { polled, finished, failed, expired, errors }
}
