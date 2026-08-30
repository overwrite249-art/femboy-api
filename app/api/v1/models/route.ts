import { authenticate } from "../../../../lib/auth/authenticate.ts"
import { errorResponse, jsonResponse } from "../../../../lib/http/respond.ts"
import { modelCardsForGroup } from "../../../../lib/relay/models.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Lists what this caller can actually use. The catalogue is derived from the
 * channels serving their group, so a key in a restricted group is not shown
 * models it would be refused.
 */
export async function GET(req: Request): Promise<Response> {
	let requestId = ""
	try {
		const auth = await authenticate(req)
		requestId = auth.requestId

		const allowed = auth.identity.allowedModels
		const cards = await modelCardsForGroup(auth.identity.group)
		const visible =
			allowed.length === 0
				? cards
				: cards.filter((card) =>
						allowed.some((pattern) =>
							pattern.endsWith("*")
								? card.id.startsWith(pattern.slice(0, -1))
								: card.id === pattern,
						),
					)

		return jsonResponse({ object: "list", data: visible }, { requestId })
	} catch (error) {
		return errorResponse(error, "openai", { requestId })
	}
}
