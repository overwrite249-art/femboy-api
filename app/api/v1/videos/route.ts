import { handleTaskList, handleTaskSubmit } from "../../../../lib/tasks/submit.ts"

export const runtime = "nodejs"

export async function POST(req: Request): Promise<Response> {
	return await handleTaskSubmit(req, {
		platform: "video",
		path: "/v1/videos",
		action: "generate",
		endpoint: "images.generations",
	})
}

export async function GET(req: Request): Promise<Response> {
	return await handleTaskList(req)
}
