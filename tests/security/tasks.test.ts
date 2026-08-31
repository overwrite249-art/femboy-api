/**
 * GW-019: asynchronous task ownership.
 *
 * The provider's job id is guessable. Ours must not be, and it must be checked
 * against its owner every time it is used.
 */

import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "node:test"

import { tasks } from "../../lib/db/index.ts"
import {
	MAX_POLL_COUNT,
	POLL_BACKOFF_MS,
	TASK_MAX_AGE_MS,
	createTask,
	dueTasks,
	extractUpstreamTaskId,
	isExpired,
	isTerminal,
	listTasks,
	markSubmitted,
	mjTaskView,
	nextPollDelayMs,
	publicTask,
	requireTask,
	rewriteTaskId,
	updateTask,
} from "../../lib/tasks/index.ts"
import { interpretPollResult, pollUrlFor } from "../../lib/tasks/poll.ts"
import type { ChannelDoc, TaskDoc } from "../../lib/db/types.ts"

const OWNER = { userId: "u-owner", role: "user" }
const STRANGER = { userId: "u-stranger", role: "user" }
const ADMIN = { userId: "u-admin", role: "admin" }

async function seed(overrides: { userId?: string } = {}): Promise<TaskDoc> {
	return await createTask({
		platform: "midjourney",
		action: "imagine",
		userId: overrides.userId ?? OWNER.userId,
		tokenId: "t-1",
		channelId: "c-1",
		model: "midjourney",
		quota: 5000,
		properties: { bytes: 42 },
	})
}

async function messageOf(action: () => Promise<unknown>): Promise<string> {
	try {
		await action()
		return ""
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

beforeEach(async () => {
	await (await tasks()).deleteMany({})
})

describe("task identifiers", () => {
	it("hands out an opaque id that is not the provider's", async () => {
		const task = await seed()
		await markSubmitted(task.taskId, "1731234567890")

		assert.match(task.taskId, /^task-[A-Za-z0-9]{28}$/)
		assert.notEqual(task.taskId, "1731234567890")
	})

	it("never serialises the provider id, the channel, or the owner", async () => {
		const task = await seed()
		await markSubmitted(task.taskId, "provider-9")
		const stored = await requireTask(task.taskId, OWNER)

		const serialized = JSON.stringify(publicTask(stored))
		assert.equal(serialized.includes("provider-9"), false)
		assert.equal(serialized.includes("c-1"), false)
		assert.equal(serialized.includes(OWNER.userId), false)
		assert.equal(serialized.includes("t-1"), false)

		const mj = JSON.stringify(mjTaskView(stored))
		assert.equal(mj.includes("provider-9"), false)
		assert.equal(mj.includes(task.taskId), true)
	})

	it("replaces every echo of the provider id in a submit reply", () => {
		const payload = {
			code: 1,
			result: "88991",
			data: { task_id: "88991", nested: { id: "88991", other: "keep" } },
			list: ["88991", "unrelated"],
		}
		const rewritten = JSON.stringify(rewriteTaskId(payload, "88991", "task-ours"))

		assert.equal(rewritten.includes("88991"), false)
		assert.equal(rewritten.includes("keep"), true)
		assert.equal(rewritten.includes("unrelated"), true)
	})

	it("finds the provider id wherever it was put", () => {
		assert.equal(extractUpstreamTaskId({ result: "abc" }), "abc")
		assert.equal(extractUpstreamTaskId({ data: { task_id: "xyz" } }), "xyz")
		assert.equal(extractUpstreamTaskId({ data: { id: 12345 } }), "12345")
		assert.equal(extractUpstreamTaskId({ nothing: true }), "")
		assert.equal(extractUpstreamTaskId(null), "")
	})
})

describe("ownership", () => {
	it("lets the owner fetch its own task", async () => {
		const task = await seed()
		const found = await requireTask(task.taskId, OWNER)
		assert.equal(found.taskId, task.taskId)
	})

	it("reports another user's task as absent, not forbidden", async () => {
		const task = await seed()
		const message = await messageOf(() => requireTask(task.taskId, STRANGER))
		assert.match(message, /no such task/i)
		// The same message a genuinely unknown id produces.
		const unknown = await messageOf(() => requireTask("task-nope", STRANGER))
		assert.equal(message, unknown)
	})

	it("lets an admin inspect any task", async () => {
		const task = await seed()
		const found = await requireTask(task.taskId, ADMIN)
		assert.equal(found.taskId, task.taskId)
	})

	it("lists only the caller's own tasks", async () => {
		await seed()
		await seed({ userId: "u-other" })

		const mine = await listTasks(OWNER)
		assert.equal(mine.length, 1)
		assert.equal(mine[0]?.userId, OWNER.userId)

		const all = await listTasks(ADMIN)
		assert.equal(all.length, 2)
	})
})

describe("polling schedule", () => {
	it("widens the interval and then clamps", () => {
		assert.equal(nextPollDelayMs(0), POLL_BACKOFF_MS[0])
		assert.ok(nextPollDelayMs(1) > nextPollDelayMs(0))
		const last = POLL_BACKOFF_MS[POLL_BACKOFF_MS.length - 1]
		assert.equal(nextPollDelayMs(99), last)
		assert.equal(nextPollDelayMs(-5), POLL_BACKOFF_MS[0])
	})

	it("only returns tasks that are actually due", async () => {
		const soon = await seed()
		await updateTask(soon.taskId, { nextPollAt: new Date(Date.now() + 60_000) })

		const ready = await seed()
		await updateTask(ready.taskId, {
			status: "in_progress",
			nextPollAt: new Date(Date.now() - 1_000),
		})

		const due = await dueTasks(10)
		const ids = due.map((row) => row.taskId)
		assert.equal(ids.includes(ready.taskId), true)
		assert.equal(ids.includes(soon.taskId), false)
	})

	it("never polls a finished task again", async () => {
		const done = await seed()
		await updateTask(done.taskId, {
			status: "success",
			nextPollAt: new Date(Date.now() - 10_000),
		})

		const due = await dueTasks(10)
		assert.equal(
			due.some((row) => row.taskId === done.taskId),
			false,
		)
		assert.equal(isTerminal("success"), true)
		assert.equal(isTerminal("in_progress"), false)
	})

	it("expires a job that never finishes", async () => {
		const task = await seed()
		assert.equal(isExpired(task), false)

		const tooManyPolls = { ...task, pollCount: MAX_POLL_COUNT + 1 }
		assert.equal(isExpired(tooManyPolls), true)

		const tooOld = { ...task, submitTime: new Date(Date.now() - TASK_MAX_AGE_MS - 1000) }
		assert.equal(isExpired(tooOld), true)
	})
})

describe("provider replies", () => {
	it("reads success, failure and progress however they are spelled", () => {
		assert.equal(interpretPollResult({ status: "SUCCESS" }).status, "success")
		assert.equal(interpretPollResult({ status: "succeed" }).status, "success")
		assert.equal(interpretPollResult({ state: "completed" }).status, "success")
		assert.equal(interpretPollResult({ status: "FAILURE" }).status, "failure")
		assert.equal(interpretPollResult({ data: { status: "failed" } }).status, "failure")
		assert.equal(interpretPollResult({ status: "IN_PROGRESS" }).status, "in_progress")
		assert.equal(interpretPollResult({ progress: "100" }).status, "success")
		assert.equal(interpretPollResult({ progress: "45%" }).progress, "45%")
	})

	it("treats an unrecognised status as still running", () => {
		const verdict = interpretPollResult({ status: "quantum-superposition" })
		assert.equal(verdict.status, "in_progress")
	})

	it("carries a failure reason through", () => {
		const verdict = interpretPollResult({ status: "failed", failReason: "banned word" })
		assert.equal(verdict.failReason, "banned word")
	})

	it("builds the poll url per platform and honours an override", async () => {
		const task = await seed()
		await markSubmitted(task.taskId, "job-7")
		const stored = await requireTask(task.taskId, OWNER)

		const channel = {
			_id: "c-1",
			baseUrl: "https://mj.example.com/",
			type: "midjourney",
			headers: {},
			config: {},
		} as unknown as ChannelDoc

		assert.equal(pollUrlFor(channel, stored), "https://mj.example.com/mj/task/job-7/fetch")

		const overridden = {
			...channel,
			config: { pollPath: "/custom/__ID__/status" },
		} as unknown as ChannelDoc
		assert.equal(pollUrlFor(overridden, stored), "https://mj.example.com/custom/job-7/status")
	})
})
