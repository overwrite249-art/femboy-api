import { handleRelayRequest } from "../../../../../lib/relay/entry.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	// Text to speech takes JSON in and returns audio bytes.
	return handleRelayRequest(req, {
		endpoint: "audio.speech",
		clientDialect: "openai",
		chat: false,
	})
}
