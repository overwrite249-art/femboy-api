import { invalidRequest, notFound } from "../../../../../lib/http/errors.ts"
import { errorResponse } from "../../../../../lib/http/respond.ts"
import { handleRelayRequest } from "../../../../../lib/relay/entry.ts"
import type { Endpoint } from "../../../../../lib/transform/index.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Gemini's surface is shaped differently from OpenAI's: the model and the
 * operation both live in the path, as `models/<model>:<method>`, and
 * streaming is a distinct method rather than a flag in the body. A catch-all
 * route is the only honest way to express that in Next's file router.
 */
function parse(segments: string[]): { model: string; endpoint: Endpoint; stream: boolean } {
	const joined = segments.join("/")
	const colon = joined.lastIndexOf(":")
	if (colon === -1) throw invalidRequest("expected models/<model>:<method>", "path")

	const model = joined.slice(0, colon)
	const method = joined.slice(colon + 1)
	if (model === "") throw invalidRequest("the model is missing from the path", "model")

	switch (method) {
		case "generateContent":
			return { model, endpoint: "chat", stream: false }
		case "streamGenerateContent":
			return { model, endpoint: "chat", stream: true }
		case "countTokens":
			return { model, endpoint: "countTokens", stream: false }
		case "embedContent":
		case "batchEmbedContents":
			return { model, endpoint: "embeddings", stream: false }
		default:
			throw notFound(`unsupported method "${method}"`)
	}
}

export async function POST(
	req: Request,
	context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
	try {
		const { path } = await context.params
		const { model, endpoint, stream } = parse(path ?? [])
		return await handleRelayRequest(req, {
			endpoint,
			clientDialect: "gemini",
			model,
			stream,
		})
	} catch (error) {
		return errorResponse(error, "gemini", {})
	}
}
