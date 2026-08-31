/**
 * The billing dashboard endpoints.
 *
 * These are OpenAI's deprecated `/v1/dashboard/billing/*` endpoints, which a
 * surprising number of clients and cost dashboards still call to decide whether
 * a key works and how much room is left. They are answered from our own ledger,
 * never from a provider: the customer's balance here is quota they bought from
 * this gateway, which has nothing to do with what any upstream account holds.
 *
 * Two deliberate simplifications, both documented in PARITY.md:
 *
 *   - `total_usage` is lifetime usage for the account, not the requested date
 *     range. Range filtering would need a rollup query per call on a deprecated
 *     endpoint, and reporting a smaller number than reality would be worse than
 *     reporting an honest larger one.
 *   - The three limit fields all carry the same value. There is one ledger, so
 *     inventing a distinct soft limit would be fiction.
 */

import { authenticate } from "../auth/authenticate.ts"
import { config } from "../config/env.ts"
import { users } from "../db/index.ts"
import { GatewayError } from "../http/errors.ts"
import { errorResponse, jsonResponse } from "../http/respond.ts"
import { currentBalance } from "../quota/index.ts"

function perUnit(): number {
	return Math.max(1, config.quotaPerUnit)
}

export async function handleBillingSubscription(req: Request): Promise<Response> {
	let requestId = ""
	try {
		const auth = await authenticate(req)
		requestId = auth.requestId
		const identity = auth.identity
		const balance = await currentBalance(identity)
		const usd = identity.unlimitedQuota ? 1_000_000 : balance / perUnit()

		return jsonResponse(
			{
				object: "billing_subscription",
				has_payment_method: true,
				canceled: false,
				canceled_at: null,
				delinquent: null,
				account_name: identity.username,
				plan: { title: identity.group, id: identity.group },
				soft_limit_usd: usd,
				hard_limit_usd: usd,
				system_hard_limit_usd: usd,
				access_until: 0,
			},
			{ requestId },
		)
	} catch (error) {
		return errorResponse(GatewayError.from(error), "openai", { requestId })
	}
}

export async function handleBillingUsage(req: Request): Promise<Response> {
	let requestId = ""
	try {
		const auth = await authenticate(req)
		requestId = auth.requestId
		const identity = auth.identity
		const doc = await (await users()).findOne({ _id: identity.userId })
		const usedQuota = doc ? doc.usedQuota : 0
		// The endpoint reports cents.
		const totalUsage = (usedQuota / perUnit()) * 100

		return jsonResponse(
			{
				object: "list",
				daily_costs: [],
				total_usage: totalUsage,
			},
			{ requestId },
		)
	} catch (error) {
		return errorResponse(GatewayError.from(error), "openai", { requestId })
	}
}
