import { handleRelayRequest } from "../../../../lib/relay/entry.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	// The moderations API lets the model be omitted.
	return handleRelayRequest(req, {
		endpoint: "moderations",
		clientDialect: "openai",
		chat: false,
		defaultModel: "omni-moderation-latest",
	})
}
