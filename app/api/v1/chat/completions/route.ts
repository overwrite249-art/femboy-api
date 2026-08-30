import { handleRelayRequest } from "../../../../../lib/relay/entry.ts"

// The MongoDB driver needs TCP, which the edge runtime does not provide.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	return handleRelayRequest(req, { endpoint: "chat", clientDialect: "openai" })
}
