import { runCronJob } from "../../../../lib/cron/guard.ts"
import { healthCheck } from "../../../../lib/cron/jobs.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
	return runCronJob(req, "health-check", healthCheck)
}

export const POST = GET
