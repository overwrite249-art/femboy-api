import test from "node:test"
import assert from "node:assert/strict"
import {
	consoleOverview,
	listSettings,
	setSetting,
} from "../../lib/admin/catalog.ts"
import { createUser, updateUser } from "../../lib/admin/store.ts"
import { setDb } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
function fresh() {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
}

test("overview shows real inventory and does not invent traffic", async () => {
	fresh()
	await createUser({ username: "operator", role: "root", quota: 0 })
	const data = await consoleOverview()
	assert.deepEqual(data.inventory, {
		channels: 0,
		enabledChannels: 0,
		tokens: 0,
		users: 1,
	})
	assert.equal((data.summary as { requests: number }).requests, 0)
	assert.ok(!JSON.stringify(data).includes("passwordHash"))
})
test("settings presentation contract uses key, not a nonexistent _id", async () => {
	fresh()
	await setSetting("example-option", { enabled: true })
	assert.deepEqual(await listSettings(), [
		{ key: "example-option", value: { enabled: true } },
	])
})
test("a stale console balance edit cannot overwrite concurrent credit changes", async () => {
	fresh()
	const user = await createUser({ username: "balance-owner", quota: 100 })
	await updateUser(user._id, { quota: 80, expectedQuota: 100 })
	await assert.rejects(
		updateUser(user._id, {
			quota: 200,
			expectedQuota: 100,
			displayName: "should-not-save",
		}),
		/balance changed/,
	)
	const current = await updateUser(user._id, {
		displayName: "unchanged balance",
	})
	assert.equal(current.quota, 80)
	assert.equal(current.displayName, "unchanged balance")
})
test("concurrent balance edits have exactly one winner", async () => {
	fresh()
	const user = await createUser({ username: "concurrent-owner", quota: 100 })
	const results = await Promise.allSettled([
		updateUser(user._id, { quota: 200, expectedQuota: 100 }),
		updateUser(user._id, { quota: 300, expectedQuota: 100 }),
	])
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	)
})
test("balance comparison inputs are validated, not used as query operators", async () => {
	fresh()
	const user = await createUser({ username: "safe-owner", quota: 100 })
	await assert.rejects(
		updateUser(user._id, { quota: 200, expectedQuota: { $gt: 0 } }),
		/number/,
	)
	await assert.rejects(
		updateUser(user._id, { expectedQuota: 100 }),
		/requires a quota/,
	)
})
