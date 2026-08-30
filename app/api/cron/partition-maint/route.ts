import { runCronJob } from "../../../../lib/cron/guard.ts"
import { partitionMaintenance } from "../../../../lib/cron/jobs.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
	return runCronJob(req, "partition-maint", partitionMaintenance)
}

export const POST = GET
