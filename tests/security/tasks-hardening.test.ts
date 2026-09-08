import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { setDb, tasks } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { setDnsResolver } from "../../lib/upstream/ssrf.ts"
import { createUser, createToken, createChannel } from "../../lib/admin/store.ts"
import { createTask, markSubmitted, publicTask, requireTask, dueTasks, isExpired, MAX_POLL_COUNT } from "../../lib/tasks/index.ts"
import { handleTaskSubmit } from "../../lib/tasks/submit.ts"

const originalFetch = globalThis.fetch
beforeEach(() => {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	setDnsResolver(async () => ["8.8.8.8"])
	process.env.KEY_PEPPER = "task-pepper-fixture"
	process.env.CHANNEL_KEY_MASTER = "task-master-fixture-0123456789abcdef"
	process.env.MIN_AUTH_LATENCY_MS = "0"
})
afterEach(() => {
	globalThis.fetch = originalFetch
	setDnsResolver(null)
})

async function job(userId = "owner", channelId = "channel") {
	return createTask({ platform: "suno", action: "generate", userId, tokenId: "token", channelId, model: "suno", quota: 10 })
}
async function world() {
	const user = await createUser({ username: "member", quota: 1_000_000 })
	const { key } = await createToken({ userId: user._id, unlimitedQuota: true })
	const channel = await createChannel({
		name: "suno", type: "suno", baseUrl: "https://provider.example", keys: ["opaque-task-provider-fixture"],
		config: { submitPaths: ["/api/v1/generate"] },
	})
	return { user, key, channel }
}
function submit(key: string, path: string, body: unknown) {
	return handleTaskSubmit(new Request(`https://gateway.test/suno${path}`, {
		method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	}), { platform: "suno", action: "generate", path })
}

test("completed task history cannot starve newer due tasks", async () => {
	for (let i = 0; i < 500; i++) {
		const old = await job()
		await (await tasks()).updateOne({ _id: old._id }, { $set: { status: "success" } })
	}
	const pending = await job()
	await (await tasks()).updateOne({ _id: pending._id }, { $set: { nextPollAt: new Date(0) } })
	assert.deepEqual((await dueTasks()).map((task) => task.taskId), [pending.taskId])
})

test("a polled result cannot re-expose numeric or nested provider job ids", async () => {
	const task = await job()
	const view = publicTask({
		...task, upstreamTaskId: "123456", result: { id: 123456, data: { task_id: "123456" } },
	})
	assert.ok(!JSON.stringify(view).includes("123456"))
})

test("unknown roles do not gain administrative task access", async () => {
	const task = await job("somebody-else")
	await assert.rejects(requireTask(task.taskId, { userId: "stranger", role: "unexpected" }), /no such task/)
})

test("the poll ceiling expires a task at the ceiling, not one poll later", async () => {
	const task = await job()
	assert.equal(isExpired({ ...task, pollCount: MAX_POLL_COUNT }), true)
})

test("a task route cannot act as an arbitrary authenticated provider POST proxy", async () => {
	const { key } = await world()
	let calls = 0
	globalThis.fetch = async () => { calls++; return Response.json({ task_id: "upstream" }) }
	const response = await submit(key, "/admin/delete-account", {})
	assert.equal(response.status, 403)
	assert.equal(calls, 0)
})

test("raw or foreign job references are refused before any provider call", async () => {
	const { key, channel } = await world()
	const foreign = await job("somebody-else", channel._id)
	await markSubmitted(foreign.taskId, "provider-private-id")
	let calls = 0
	globalThis.fetch = async () => { calls++; return Response.json({ task_id: "new-job" }) }
	for (const taskId of ["provider-private-id", foreign.taskId]) {
		const response = await submit(key, "/api/v1/generate", { task_id: taskId })
		assert.equal(response.status, 404)
	}
	assert.equal(calls, 0)
})

test("an owned gateway job reference is translated only for its original channel", async () => {
	const { user, key, channel } = await world()
	const owned = await job(user._id, channel._id)
	await markSubmitted(owned.taskId, "provider-owned-id")
	let forwarded: Record<string, unknown> = {}
	globalThis.fetch = async (_url, init) => {
		forwarded = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array))
		return Response.json({ task_id: "new-provider-id" })
	}
	const response = await submit(key, "/api/v1/generate", { task_id: owned.taskId })
	assert.equal(response.status, 200)
	assert.equal(forwarded.task_id, "provider-owned-id")
	assert.ok(!(await response.text()).includes("new-provider-id"))
})