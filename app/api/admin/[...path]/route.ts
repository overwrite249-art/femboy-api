import { handleAdminRequest } from "../../../../lib/admin/router.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ path?: string[] }> }

async function handle(req: Request, context: Context): Promise<Response> {
	const { path } = await context.params
	return await handleAdminRequest(req, path ?? [])
}

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
