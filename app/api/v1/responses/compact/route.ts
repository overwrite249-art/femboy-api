import { handleRelayRequest } from "../../../../../lib/relay/entry.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	// The compaction variant of the Responses API. Same wire shape, same billing;
	// the provider decides what to summarise.
	return await handleRelayRequest(req, {
		endpoint: "chat",
		clientDialect: "openai",
		chat: false,
	})
}
