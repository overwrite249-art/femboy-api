import { handleBillingUsage } from "../../../../../../lib/relay/dashboard.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
	return await handleBillingUsage(req)
}
