import { handleTaskList } from "../../../../lib/tasks/submit.ts"

export const runtime = "nodejs"

export async function GET(req: Request): Promise<Response> {
	return await handleTaskList(req)
}
