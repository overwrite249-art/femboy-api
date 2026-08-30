import { runCronJob } from "../../../../lib/cron/guard.ts"
import { rollupUsage } from "../../../../lib/cron/jobs.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
	return runCronJob(req, "rollup", rollupUsage)
}

export const POST = GET
