import { handleTaskFetch } from "../../../../../../lib/tasks/submit.ts"

export const runtime = "nodejs"

function taskIdFrom(pathname: string): string {
	const parts = pathname.split("/").filter((part) => part.length > 0)
	const index = parts.lastIndexOf("task")
	if (index >= 0 && parts.length > index + 1) return parts[index + 1] ?? ""
	return ""
}

export async function GET(req: Request): Promise<Response> {
	return await handleTaskFetch(req, taskIdFrom(new URL(req.url).pathname), "midjourney")
}

export async function POST(req: Request): Promise<Response> {
	return await GET(req)
}
