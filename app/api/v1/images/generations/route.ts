import { handleRelayRequest } from "../../../../../lib/relay/entry.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	return handleRelayRequest(req, {
		endpoint: "images.generations",
		clientDialect: "openai",
		chat: false,
		defaultModel: "gpt-image-1",
	})
}
