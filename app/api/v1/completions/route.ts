import { handleRelayRequest } from "../../../../lib/relay/entry.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	// The legacy completions API carries `prompt` rather than `messages`.
	return handleRelayRequest(req, {
		endpoint: "completions",
		clientDialect: "openai",
		chat: false,
	})
}
