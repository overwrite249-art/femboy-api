import { handlePassthroughRequest } from "../../../../../lib/relay/passthrough.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
	// The image and mask arrive as file parts and must not be re-encoded.
	return handlePassthroughRequest(req, {
		endpoint: "images.edits",
		multipart: true,
		defaultModel: "gpt-image-1",
	})
}
