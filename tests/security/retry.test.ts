import test from "node:test"
import assert from "node:assert/strict"

process.env.CHANNEL_KEY_MASTER = "unit-test-master-key-0123456789abcdef"
process.env.CHANNEL_KEY_VERSION = "1"
process.env.CHANNEL_AUTO_DISABLE_FAILS = "0"

import { config } from "../../lib/config/env.ts"
import { channelKeys, channels, setDb } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import type { ChannelDoc } from "../../lib/db/types.ts"
import { ErrorCode, GatewayError } from "../../lib/http/errors.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import { sealSecret } from "../../lib/util/crypto.ts"
import { shouldRetryError, withChannelRetry } from "../../lib/routing/retry.ts"
import { isChannelOpen } from "../../lib/routing/health.ts"

function channelDoc(id: string, priority: number): ChannelDoc {
	return {
		_id: id,
		name: id,
		type: "openai",
		baseUrl: "https://api.example.com",
		status: "enabled",
		priority,
		weight: 0,
		groups: ["default"],
		models: ["gpt-4o"],
		modelMapping: {},
		headers: {},
		autoDisabled: false,
		failCount: 0,
		config: {},
		createdAt: new Date(),
		updatedAt: new Date(),
	}
}

/** Seeds N channels at descending priority, each with one credential. */
async function fresh(count: number) {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())
	const channelCollection = await channels()
	const keyCollection = await channelKeys()
	for (let i = 0; i < count; i++) {
		const id = `c${i}`
		await channelCollection.insertOne(channelDoc(id, 100 - i))
		const sealed = await sealSecret(`sk-${id}`, config.channelKeyMaster, config.channelKeyVersion)
		await keyCollection.insertOne({
			_id: `k-${id}`,
			channelId: id,
			cipher: sealed.cipher,
			iv: sealed.iv,
			authTag: sealed.authTag,
			keyVersion: sealed.keyVersion,
			fingerprint: sealed.fingerprint,
			status: "enabled",
			index: 0,
			failCount: 0,
			createdAt: new Date(),
		})
	}
}

function upstreamError(upstreamStatus: number): GatewayError {
	return new GatewayError({
		code: ErrorCode.UPSTREAM_ERROR,
		status: 502,
		message: `upstream returned ${upstreamStatus}`,
		upstreamStatus,
	})
}

const request = { group: "default", model: "gpt-4o" }

test("the retry matrix is only applied to upstream failures", () => {
	// Transient upstream conditions are worth another channel.
	assert.equal(shouldRetryError(upstreamError(500)), true)
	assert.equal(shouldRetryError(upstreamError(429)), true)
	assert.equal(shouldRetryError(upstreamError(503)), true)
	// A bad request will be just as bad everywhere else.
	assert.equal(shouldRetryError(upstreamError(400)), false)
	assert.equal(shouldRetryError(upstreamError(408)), false)
	assert.equal(shouldRetryError(upstreamError(504)), false)
	assert.equal(shouldRetryError(upstreamError(200)), false)

	// Gateway-side failures carry no upstream status. 402 and 403 sit inside
	// the retryable 401-407 band, so applying the matrix to them would replay
	// an unpayable request against every channel.
	const quota = new GatewayError({
		code: ErrorCode.INSUFFICIENT_QUOTA,
		status: 402,
		message: "insufficient quota",
	})
	assert.equal(shouldRetryError(quota), false)

	const forbidden = new GatewayError({
		code: ErrorCode.MODEL_NOT_ALLOWED,
		status: 403,
		message: "model not allowed",
	})
	assert.equal(shouldRetryError(forbidden), false)

	// A truncated body is not transient.
	assert.equal(
		shouldRetryError(
			new GatewayError({
				code: ErrorCode.MALFORMED_UPSTREAM_BODY,
				status: 502,
				message: "truncated",
				upstreamStatus: 502,
			}),
		),
		false,
	)

	// The client is gone.
	assert.equal(
		shouldRetryError(
			new GatewayError({ code: ErrorCode.UPSTREAM_TIMEOUT, status: 499, message: "closed" }),
		),
		false,
	)

	// An explicit flag is honoured when there is no upstream status.
	assert.equal(
		shouldRetryError(
			new GatewayError({
				code: ErrorCode.UPSTREAM_UNREACHABLE,
				status: 502,
				message: "connect failed",
				retryable: true,
			}),
		),
		true,
	)
})

test("a first-attempt success costs exactly one attempt", async () => {
	await fresh(3)
	let calls = 0
	const outcome = await withChannelRetry(request, async (ctx) => {
		calls++
		assert.equal(ctx.attempt, 0)
		assert.equal(ctx.key.secret, "sk-c0")
		return "ok"
	})
	assert.equal(outcome.value, "ok")
	assert.equal(outcome.attempts, 1)
	assert.equal(outcome.channelId, "c0")
	assert.equal(calls, 1)
})

test("a failing channel is retried on a different one", async () => {
	await fresh(3)
	const seen: string[] = []
	const outcome = await withChannelRetry(request, async (ctx) => {
		seen.push(ctx.channel._id)
		if (ctx.attempt === 0) throw upstreamError(500)
		return "recovered"
	})
	assert.equal(outcome.value, "recovered")
	assert.equal(outcome.attempts, 2)
	assert.equal(seen.length, 2)
	// The second attempt must not land on the channel that just failed.
	assert.notEqual(seen[0], seen[1])
})

test("a non-retryable failure stops immediately", async () => {
	await fresh(3)
	let calls = 0
	await assert.rejects(
		() =>
			withChannelRetry(request, async () => {
				calls++
				throw upstreamError(400)
			}),
		/upstream returned 400/,
	)
	assert.equal(calls, 1, "a 400 must not be replayed against other channels")
})

test("an exhausted quota is never replayed across channels", async () => {
	await fresh(5)
	let calls = 0
	await assert.rejects(
		() =>
			withChannelRetry(request, async () => {
				calls++
				throw new GatewayError({
					code: ErrorCode.INSUFFICIENT_QUOTA,
					status: 402,
					message: "insufficient quota",
				})
			}),
		/insufficient quota/,
	)
	assert.equal(calls, 1)
})

test("attempts are capped even when every channel fails", async () => {
	await fresh(10)
	let calls = 0
	await assert.rejects(
		() =>
			withChannelRetry({ ...request, maxAttempts: 3 }, async () => {
				calls++
				throw upstreamError(500)
			}),
		/upstream returned 500/,
	)
	// Ten channels are available; the cap is what stops the stampede.
	assert.equal(calls, 3)
})

test("the budget bounds the whole request, not each attempt", async () => {
	await fresh(10)
	let calls = 0
	const started = Date.now()
	await assert.rejects(
		() =>
			withChannelRetry({ ...request, maxAttempts: 10, budgetMs: 120 }, async () => {
				calls++
				await new Promise((r) => setTimeout(r, 40))
				throw upstreamError(500)
			}),
		/upstream returned 500/,
	)
	const elapsed = Date.now() - started
	assert.ok(calls < 10, `expected the budget to cut the attempts short, made ${calls}`)
	assert.ok(elapsed < 2000, `expected to give up promptly, took ${elapsed}ms`)
})

test("failures are reported to the breaker and successes clear it", async () => {
	await fresh(2)

	// Fail the preferred channel enough times to open its breaker.
	for (let i = 0; i < config.channelFailureThreshold; i++) {
		await assert.rejects(() =>
			withChannelRetry({ ...request, maxAttempts: 1 }, async () => {
				throw upstreamError(500)
			}),
		)
	}
	assert.equal(await isChannelOpen("c0"), true)

	// With c0 out, traffic goes to c1 and succeeds.
	const outcome = await withChannelRetry(request, async () => "ok")
	assert.equal(outcome.channelId, "c1")
})

test("a client abort is not blamed on the channel", async () => {
	await fresh(2)
	await assert.rejects(() =>
		withChannelRetry({ ...request, maxAttempts: 3 }, async () => {
			throw new GatewayError({
				code: ErrorCode.UPSTREAM_TIMEOUT,
				status: 499,
				message: "client closed the request",
			})
		}),
	)
	// The channel did nothing wrong, so its failure counter must be untouched.
	assert.equal(await isChannelOpen("c0"), false)
})

test("an already-aborted request never reaches an upstream", async () => {
	await fresh(2)
	const controller = new AbortController()
	controller.abort()
	let calls = 0
	await assert.rejects(() =>
		withChannelRetry({ ...request, signal: controller.signal }, async () => {
			calls++
			return "ok"
		}),
	)
	assert.equal(calls, 0)
})

test("when no channel is configured the caller gets a clean 503", async () => {
	await fresh(0)
	let calls = 0
	await assert.rejects(
		() =>
			withChannelRetry(request, async () => {
				calls++
				return "ok"
			}),
		/no channel is able to serve/i,
	)
	assert.equal(calls, 0)
})

test("a channel with no credentials is skipped, not fatal", async () => {
	await fresh(2)
	// Remove c0's only credential; c1 should still serve the request.
	await (await channelKeys()).deleteOne({ _id: "k-c0" })
	const outcome = await withChannelRetry(request, async (ctx) => ctx.channel._id)
	assert.equal(outcome.value, "c1")
	assert.equal(outcome.channelId, "c1")
})
