export const runtime = "nodejs"

/**
 * The realtime API is a WebSocket protocol. A serverless function cannot hold a
 * long-lived bidirectional connection, so this deployment refuses it explicitly
 * rather than accepting the upgrade and failing halfway through a session.
 *
 * A half-working realtime endpoint is worse than an honest refusal: the client
 * would authenticate, start streaming audio, and lose the socket at the platform
 * timeout with no way to tell why. What it would take to support properly is
 * described in docs/ROADMAP.md.
 */
const BODY = {
	error: {
		message:
			"the realtime websocket api is not served by this deployment. a websocket relay needs a long-lived bidirectional connection, which a serverless function cannot hold. see docs/ROADMAP.md for what a supported implementation requires.",
		type: "invalid_request_error",
		code: "not_implemented",
		param: null,
	},
}

function refuse(): Response {
	return new Response(JSON.stringify(BODY), {
		status: 501,
		headers: {
			"content-type": "application/json",
			// Tell an upgrade attempt plainly that no protocol is on offer.
			"x-gateway-realtime": "unsupported",
		},
	})
}

export async function GET(): Promise<Response> {
	return refuse()
}

export async function POST(): Promise<Response> {
	return refuse()
}
