import { handleTaskFetch, handleTaskSubmit } from "../../../../lib/tasks/submit.ts"

export const runtime = "nodejs"

function restFrom(pathname: string, prefix: string): string[] {
	const parts = pathname.split("/").filter((part) => part.length > 0)
	const index = parts.lastIndexOf(prefix)
	return index >= 0 ? parts.slice(index + 1) : parts
}

export async function POST(req: Request): Promise<Response> {
	const rest = restFrom(new URL(req.url).pathname, "kling")
	return await handleTaskSubmit(req, {
		platform: "kling",
		path: "/" + rest.join("/"),
		action: rest[rest.length - 1] ?? "generate",
		endpoint: "images.generations",
	})
}

export async function GET(req: Request): Promise<Response> {
	const rest = restFrom(new URL(req.url).pathname, "kling")
	return await handleTaskFetch(req, rest[rest.length - 1] ?? "", "openai")
}
