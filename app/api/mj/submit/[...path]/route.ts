import { handleTaskSubmit } from "../../../../../lib/tasks/submit.ts"

export const runtime = "nodejs"

function actionFrom(pathname: string): string {
	const parts = pathname.split("/").filter((part) => part.length > 0)
	const index = parts.lastIndexOf("submit")
	if (index >= 0 && parts.length > index + 1) return parts.slice(index + 1).join("/")
	return parts[parts.length - 1] ?? "imagine"
}

export async function POST(req: Request): Promise<Response> {
	const action = actionFrom(new URL(req.url).pathname)
	return await handleTaskSubmit(req, {
		platform: "midjourney",
		path: "/mj/submit/" + action,
		action,
		endpoint: "images.generations",
	})
}
