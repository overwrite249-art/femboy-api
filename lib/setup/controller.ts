import { requireAdmin } from "../admin/guard.ts"
import { recordAudit } from "../admin/audit.ts"
import { invalidRequest } from "../http/errors.ts"
import { errorResponse, jsonResponse } from "../http/respond.ts"
import { asRecord, readLimitedText, safeJsonParse } from "../util/json.ts"
import { configureScheduler, schedulerStatus } from "./cron-job-org.ts"

export async function handleSchedulerSetup(req: Request): Promise<Response> {
	try {
		const actor = await requireAdmin(req, "root")
		if (req.method === "GET") return jsonResponse(await schedulerStatus())
		if (req.method !== "POST") return jsonResponse({ error: { message: "method not allowed" } }, { status: 405 })
		const text = await readLimitedText(req.body, 4096)
		const body = asRecord(safeJsonParse(text, { maxBytes: 4096, maxDepth: 4, maxNodes: 10 }))
		if (Object.keys(body).some((key) => key !== "apiKey")) throw invalidRequest("Only the cron-job.org API key is accepted.")
		const result = await configureScheduler(body.apiKey)
		await recordAudit({
			actorId: actor.userId, actorRole: actor.role, ipHash: actor.ipHash,
			action: "setup.cron-job-org", targetType: "scheduler", targetId: "cron-job-org",
			meta: { origin: result.origin, created: result.created, updated: result.updated },
		})
		return jsonResponse(result)
	} catch (error) {
		return errorResponse(error)
	}
}