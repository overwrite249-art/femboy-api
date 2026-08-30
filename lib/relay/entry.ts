/**
 * The HTTP entry point shared by every relay route.
 *
 * Routes are the easiest place in a gateway to introduce an inconsistency:
 * one of them forgets to cap the body, or authenticates after parsing, or
 * returns an OpenAI-shaped error to an Anthropic client. Centralising the
 * order here means a new endpoint is a declaration rather than a
 * reimplementation.
 *
 * The ordering that matters:
 *   1. authenticate first, so an anonymous caller cannot make us buffer
 *      megabytes of JSON before being refused
 *   2. read with a ceiling *while* reading, not after (GW-008)
 *   3. parse with a reviver that drops dangerous keys (GW-017)
 *   4. normalise into the shape the pipeline expects
 */

import { config } from "../config/env.ts"
import { authenticate } from "../auth/authenticate.ts"
import { invalidRequest } from "../http/errors.ts"
import { errorResponse } from "../http/respond.ts"
import type { Dialect as RespondDialect } from "../http/respond.ts"
import { asString, isPlainObject, readLimitedText, safeJsonParse, sanitizeParsed } from "../util/json.ts"
import { normalizeOpenaiRequest } from "../transform/openai.ts"
import type { NormalizedRequest } from "../transform/openai.ts"
import type { Dialect, Endpoint } from "../transform/index.ts"
import { relay } from "./pipeline.ts"

export type RelayRouteOptions = {
	endpoint: Endpoint
	clientDialect: Dialect
	/**
	 * Whether the body must carry a `messages` array. Completions, embeddings,
	 * images and the Responses API all use different input fields.
	 */
	chat?: boolean
	/** Used where the API makes the model optional, such as moderations. */
	defaultModel?: string
	/** Gemini puts the model in the path rather than the body. */
	model?: string
	/** Gemini decides streaming by method name rather than a body flag. */
	stream?: boolean
}

function normalizeFor(options: RelayRouteOptions, raw: unknown): NormalizedRequest {
	if (options.clientDialect === "openai") {
		const withDefault =
			options.defaultModel && isPlainObject(raw) && asString(raw.model) === ""
				? { ...raw, model: options.defaultModel }
				: raw
		return normalizeOpenaiRequest(withDefault, { chat: options.chat })
	}

	if (!isPlainObject(raw)) throw invalidRequest("request body must be a JSON object")
	const body = sanitizeParsed({ ...raw })

	if (options.clientDialect === "anthropic") {
		const model = asString(body.model) || (options.defaultModel ?? "")
		if (model === "") throw invalidRequest("the model field is required", "model")
		// Anthropic reports usage on every response, so nothing has to be
		// injected to make a stream billable.
		return { body, model, stream: body.stream === true, usageInjected: false }
	}

	const model = options.model ?? asString(body.model)
	if (model === "") throw invalidRequest("the model must be given in the path", "model")
	return { body, model, stream: options.stream === true, usageInjected: false }
}

/** Handles a relay request from parse to response, including failures. */
export async function handleRelayRequest(
	req: Request,
	options: RelayRouteOptions,
): Promise<Response> {
	const dialect = options.clientDialect as RespondDialect
	let requestId = ""

	try {
		const auth = await authenticate(req)
		requestId = auth.requestId

		const text = await readLimitedText(req.body, config.maxRequestBodyBytes)
		const raw = text === "" ? {} : safeJsonParse<unknown>(text)
		const normalized = normalizeFor(options, raw)

		return await relay({
			req,
			auth,
			endpoint: options.endpoint,
			clientDialect: options.clientDialect,
			body: normalized.body,
			model: normalized.model,
			stream: normalized.stream,
			usageInjected: normalized.usageInjected,
		})
	} catch (error) {
		return errorResponse(error, dialect, { requestId })
	}
}
