/**
 * Cron authorisation.
 *
 * These endpoints are publicly routable - Vercel invokes them over HTTP like
 * any other request - so "only the scheduler calls this" is not a control.
 * The `x-vercel-cron` header is not evidence either; anyone can send it.
 *
 * The shared secret is compared through a hash with a constant-time equality
 * (GW-028). Comparing the raw strings with === would return early on the
 * first differing byte, which is enough to recover the secret one character
 * at a time from a few thousand timed requests.
 */

import { config } from "../config/env.ts"
import { ErrorCode, GatewayError } from "../http/errors.ts"
import { errorResponse, jsonResponse } from "../http/respond.ts"
import { sha256Hex, timingSafeEqualHex } from "../util/crypto.ts"
import { nowMs } from "../util/time.ts"

function presentedSecret(req: Request): string {
	const header = req.headers.get("authorization") ?? ""
	if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim()
	return req.headers.get("x-cron-secret")?.trim() ?? ""
}

export async function assertCronAuthorized(req: Request): Promise<void> {
	const secret = config.cronSecret
	if (secret === "") {
		// Fail closed. An unconfigured secret must not mean "open to everyone".
		throw new GatewayError({
			code: ErrorCode.CONFIGURATION_ERROR,
			status: 503,
			message: "CRON_SECRET is not configured",
		})
	}

	const presented = presentedSecret(req)
	// Hashing first means the comparison length never depends on the input.
	const [a, b] = await Promise.all([sha256Hex(`cron:${presented}`), sha256Hex(`cron:${secret}`)])
	if (!timingSafeEqualHex(a, b)) {
		throw new GatewayError({
			code: ErrorCode.INSUFFICIENT_PERMISSIONS,
			status: 403,
			message: "cron authorization failed",
		})
	}
}

/** Authorises, runs, times and reports a job without ever leaking a stack. */
export async function runCronJob(
	req: Request,
	name: string,
	job: () => Promise<Record<string, unknown>>,
): Promise<Response> {
	const started = nowMs()
	try {
		await assertCronAuthorized(req)
		const result = await job()
		return jsonResponse({ job: name, ok: true, elapsedMs: nowMs() - started, ...result })
	} catch (error) {
		return errorResponse(error, "openai", {})
	}
}
