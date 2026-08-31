import { handleAuthRequest } from "../../../../lib/admin/login.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ path?: string[] }> }

async function handle(req: Request, context: Context): Promise<Response> {
	const { path } = await context.params
	return await handleAuthRequest(req, path ?? [])
}

export const GET = handle
export const POST = handle
