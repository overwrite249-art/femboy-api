import { runCronJob } from "../../../../lib/cron/guard.ts"
import { reconcileQuota } from "../../../../lib/cron/jobs.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
	return runCronJob(req, "reconcile-quota", reconcileQuota)
}

export const POST = GET
