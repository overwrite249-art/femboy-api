import { runCronJob } from "../../../../lib/cron/guard.ts"
import { pollDueTasks } from "../../../../lib/tasks/poll.ts"

export const runtime = "nodejs"

export async function GET(req: Request): Promise<Response> {
	return await runCronJob(req, "poll-tasks", () => pollDueTasks(50))
}

export async function POST(req: Request): Promise<Response> {
	return await GET(req)
}
