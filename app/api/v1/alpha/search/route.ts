import { handleRelayRequest } from "../../../../../lib/relay/entry.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	// Provider-side web search. Billed as a chat completion plus whatever tool
	// surcharge the pricing table carries for the model (see docs/COST.md).
	return await handleRelayRequest(req, {
		endpoint: "chat",
		clientDialect: "openai",
		chat: false,
	})
}
