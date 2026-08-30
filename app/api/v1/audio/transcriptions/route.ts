import { handlePassthroughRequest } from "../../../../../lib/relay/passthrough.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	return handlePassthroughRequest(req, {
		endpoint: "audio.transcriptions",
		multipart: true,
		defaultModel: "whisper-1",
	})
}
