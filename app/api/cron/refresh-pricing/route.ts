import { runCronJob } from "../../../../lib/cron/guard.ts"
import { refreshPricing } from "../../../../lib/cron/jobs.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
	return runCronJob(req, "refresh-pricing", refreshPricing)
}

export const POST = GET
