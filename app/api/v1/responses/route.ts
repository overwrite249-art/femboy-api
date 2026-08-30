import { handleRelayRequest } from "../../../../lib/relay/entry.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	// The Responses API uses `input` rather than `messages`.
	return handleRelayRequest(req, {
		endpoint: "chat",
		clientDialect: "openai",
		chat: false,
	})
}
