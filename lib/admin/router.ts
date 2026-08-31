/**
 * The /api/admin dispatcher.
 *
 * A hand-written switch rather than a framework router, for the same reason the
 * relay routes are thin: the whole control plane is reviewable in one file, and
 * there is no route-matching library between a request and the authority it is
 * asking for.
 *
 * Every mutation writes an audit row. Every response is JSON. Nothing here
 * returns a credential except the two endpoints that mint one, and those return
 * it exactly once.
 */

import { errorResponse, jsonResponse } from "../http/respond.ts"
import { notFound } from "../http/errors.ts"
import { healthCheck } from "../cron/jobs.ts"
import { recordAudit } from "./audit.ts"
import {
	consoleOverview,
	createRedemptionBatch,
	deleteMapping,
	deletePricing,
	listAudit,
	listGroupRatios,
	listMappings,
	listPricing,
	listRedemptionCodes,
	listSettings,
	listUsage,
	redeemCode,
	setSetting,
	upsertGroupRatio,
	upsertMapping,
	upsertPricing,
	usageSummary,
} from "./catalog.ts"
import { pagination, readAdminBody, requireAdmin } from "./guard.ts"
import type { AdminContext } from "./guard.ts"
import {
	createChannel,
	createToken,
	createUser,
	deleteChannel,
	deleteToken,
	getUser,
	listChannels,
	listTokens,
	listUsers,
	replaceChannelKeys,
	rotateToken,
	tokenView,
	updateChannel,
	updateToken,
	updateUser,
} from "./store.ts"
import { getToken } from "./store.ts"

function ok(body: unknown, context: AdminContext, status = 200): Response {
	return jsonResponse(body as Record<string, unknown>, {
		status,
		requestId: context.requestId,
	})
}

async function audit(
	context: AdminContext,
	action: string,
	targetType: string,
	targetId: string,
	meta?: Record<string, unknown>,
): Promise<void> {
	await recordAudit({
		actorId: context.userId,
		actorRole: context.role,
		action,
		targetType,
		targetId,
		meta,
		ipHash: context.ipHash,
	})
}

export async function handleAdminRequest(req: Request, segments: string[]): Promise<Response> {
	const url = new URL(req.url)
	const method = req.method.toUpperCase()
	const [head = "", second = "", third = ""] = segments

	// `redeem` is the one endpoint here an ordinary user may call: it spends a
	// code against their own account and cannot name a different one.
	const minimum = head === "redeem" ? "user" : "admin"

	let context: AdminContext
	try {
		context = await requireAdmin(req, minimum)
	} catch (error) {
		return errorResponse(error, "openai", {})
	}

	try {
		const body = await readAdminBody(req)
		const { limit, skip } = pagination(url)

		switch (head) {
			case "":
			case "overview": {
				return ok(await consoleOverview(), context)
			}

			case "whoami": {
				return ok(
					{
						userId: context.userId,
						username: context.username,
						role: context.role,
						via: context.via,
					},
					context,
				)
			}

			// ---------------------------------------------------------------
			case "users": {
				if (!second && method === "GET") return ok({ users: await listUsers({ limit, skip }) }, context)
				if (!second && method === "POST") {
					const user = await createUser(body)
					await audit(context, "user.create", "user", user._id, { username: user.username })
					return ok({ user }, context, 201)
				}
				if (second && method === "GET") return ok({ user: await getUser(second) }, context)
				if (second && (method === "PATCH" || method === "PUT")) {
					const user = await updateUser(second, body)
					await audit(context, "user.update", "user", second, body)
					return ok({ user }, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "tokens": {
				if (!second && method === "GET") {
					const userId = url.searchParams.get("userId") ?? undefined
					return ok({ tokens: await listTokens(userId, { limit, skip }) }, context)
				}
				if (!second && method === "POST") {
					const created = await createToken(body)
					await audit(context, "token.create", "token", created.token._id, {
						userId: created.token.userId,
					})
					// The only time the plaintext is ever returned.
					return ok({ token: created.token, key: created.key }, context, 201)
				}
				if (second && third === "rotate" && method === "POST") {
					const rotated = await rotateToken(second)
					await audit(context, "token.rotate", "token", second)
					return ok({ token: rotated.token, key: rotated.key }, context)
				}
				if (second && method === "GET") {
					return ok({ token: tokenView(await getToken(second)) }, context)
				}
				if (second && (method === "PATCH" || method === "PUT")) {
					const token = await updateToken(second, body)
					await audit(context, "token.update", "token", second, body)
					return ok({ token }, context)
				}
				if (second && method === "DELETE") {
					await deleteToken(second)
					await audit(context, "token.delete", "token", second)
					return ok({ deleted: true }, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "channels": {
				if (second === "test" && method === "POST") {
					// Tests every enabled channel with a one-token completion and
					// records the outcome, so the breaker state reflects reality.
					const report = await healthCheck()
					await audit(context, "channel.test", "channel", "*")
					return ok(report, context)
				}
				if (!second && method === "GET") {
					return ok({ channels: await listChannels({ limit, skip }) }, context)
				}
				if (!second && method === "POST") {
					const channel = await createChannel(body)
					// `body` contains plaintext keys; the audit layer scrubs them.
					await audit(context, "channel.create", "channel", channel._id, body)
					return ok({ channel }, context, 201)
				}
				if (second && third === "keys" && method === "POST") {
					const keys = Array.isArray(body.keys) ? (body.keys as string[]) : []
					const count = await replaceChannelKeys(second, keys)
					await audit(context, "channel.keys.replace", "channel", second, { count })
					return ok({ keyCount: count }, context)
				}
				if (second && (method === "PATCH" || method === "PUT")) {
					const channel = await updateChannel(second, body)
					await audit(context, "channel.update", "channel", second, body)
					return ok({ channel }, context)
				}
				if (second && method === "DELETE") {
					await deleteChannel(second)
					await audit(context, "channel.delete", "channel", second)
					return ok({ deleted: true }, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "pricing": {
				if (!second && method === "GET") return ok({ pricing: await listPricing() }, context)
				if (!second && (method === "POST" || method === "PUT")) {
					const row = await upsertPricing(body)
					await audit(context, "pricing.upsert", "pricing", row._id, body)
					return ok({ pricing: row }, context)
				}
				if (second && method === "DELETE") {
					await deletePricing(decodeURIComponent(second))
					await audit(context, "pricing.delete", "pricing", second)
					return ok({ deleted: true }, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "mappings": {
				if (!second && method === "GET") return ok({ mappings: await listMappings() }, context)
				if (!second && (method === "POST" || method === "PUT")) {
					const row = await upsertMapping(body)
					await audit(context, "mapping.upsert", "mapping", row._id, body)
					return ok({ mapping: row }, context)
				}
				if (second && method === "DELETE") {
					await deleteMapping(decodeURIComponent(second))
					await audit(context, "mapping.delete", "mapping", second)
					return ok({ deleted: true }, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "group-ratios": {
				if (method === "GET") return ok({ groupRatios: await listGroupRatios() }, context)
				if (method === "POST" || method === "PUT") {
					const row = await upsertGroupRatio(body)
					await audit(context, "groupRatio.upsert", "groupRatio", row._id, body)
					return ok({ groupRatio: row }, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "redemption": {
				if (method === "GET") {
					return ok({ codes: await listRedemptionCodes(second || undefined) }, context)
				}
				if (method === "POST") {
					const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null
					const batch = await createRedemptionBatch({
						count: Number(body.count ?? 1),
						quota: Number(body.quota ?? 0),
						createdBy: context.userId,
						expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
					})
					await audit(context, "redemption.create", "redemption", batch.batchId, {
						count: batch.codes.length,
						quota: body.quota,
					})
					// Codes are shown once, like keys.
					return ok(batch, context, 201)
				}
				break
			}

			case "redeem": {
				if (method === "POST") {
					const result = await redeemCode(String(body.code ?? ""), context.userId)
					await audit(context, "redemption.redeem", "user", context.userId, {
						quota: result.quota,
					})
					return ok(result, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "settings": {
				if (method === "GET") return ok({ settings: await listSettings() }, context)
				if (method === "POST" || method === "PUT") {
					const key = String(body.key ?? "")
					await setSetting(key, body.value)
					await audit(context, "setting.set", "setting", key, { key })
					return ok({ saved: true }, context)
				}
				break
			}

			// ---------------------------------------------------------------
			case "usage": {
				if (method === "GET") {
					if (second === "summary") {
						const bucket = url.searchParams.get("bucket") ?? undefined
						return ok({ summary: await usageSummary(bucket || undefined) }, context)
					}
					return ok(
						{
							usage: await listUsage({
								userId: url.searchParams.get("userId") ?? undefined,
								tokenId: url.searchParams.get("tokenId") ?? undefined,
								channelId: url.searchParams.get("channelId") ?? undefined,
								model: url.searchParams.get("model") ?? undefined,
								status: url.searchParams.get("status") ?? undefined,
								bucket: url.searchParams.get("bucket") ?? undefined,
								limit,
								skip,
							}),
						},
						context,
					)
				}
				break
			}

			case "audit": {
				if (method === "GET") return ok({ audit: await listAudit({ limit, skip }) }, context)
				break
			}
		}

		throw notFound(`no admin route for ${method} /${segments.join("/")}`)
	} catch (error) {
		return errorResponse(error, "openai", { requestId: context.requestId })
	}
}
