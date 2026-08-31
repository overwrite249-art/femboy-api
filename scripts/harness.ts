/**
 * A local stub provider.
 *
 * The point of this script is that nothing has to be tested against a paid
 * endpoint. It speaks enough of all four dialects, plus the Midjourney
 * submit-and-poll cycle, that the gateway can be run end to end for free:
 *
 *   node --experimental-strip-types scripts/harness.ts     # port 8787
 *   # then add a channel with baseUrl http://127.0.0.1:8787 and any key
 *
 * Deliberate behaviours, because the interesting bugs are here:
 *
 *   - Streaming responses arrive in several chunks with a real delay, so a
 *     gateway that accidentally buffers is visible.
 *   - A multibyte character is split across two chunks on purpose.
 *   - Usage is omitted from OpenAI streams unless `stream_options.include_usage`
 *     is set, exactly like the real API.
 *   - A Midjourney task reports NOT_START, then IN_PROGRESS with a percentage,
 *     then SUCCESS, across successive polls.
 *   - `?fail=429` on any path returns that status with a provider-shaped error,
 *     for exercising retry and breaker behaviour.
 */

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

const PORT = Number(process.env.HARNESS_PORT ?? "8787")
const MODEL_LIST = [
	"gpt-4o",
	"gpt-4o-mini",
	"claude-sonnet-4",
	"gemini-2.0-flash",
	"text-embedding-3-small",
]

/** Poll counts per task id, so a task progresses across calls. */
const mjPolls = new Map<string, number>()
let mjSeq = 1000

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
	})
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(text),
	})
	res.end(text)
}

function sseHead(res: ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
	})
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseJson(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text)
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
	} catch {
		// A stub provider is allowed to be strict about nothing.
	}
	return {}
}

// The word is split mid-character on purpose: "日" is three bytes in UTF-8 and
// the gateway must not corrupt it when it lands across a chunk boundary.
const PIECES = ["Hello", " from ", "the har", "ness ", "日本", " done."]

async function openaiChat(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
	const model = typeof body.model === "string" ? body.model : "gpt-4o"
	const stream = body.stream === true
	const options = body.stream_options
	const wantsUsage =
		options && typeof options === "object"
			? (options as Record<string, unknown>).include_usage === true
			: false

	if (!stream) {
		json(res, 200, {
			id: "chatcmpl-harness",
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: PIECES.join("") },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
		})
		return
	}

	sseHead(res)
	for (const piece of PIECES) {
		const frame = {
			id: "chatcmpl-harness",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
		}
		res.write(`data: ${JSON.stringify(frame)}\n\n`)
		await sleep(60)
	}
	res.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-harness",
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	)
	// Exactly like the real API: no usage unless it was asked for.
	if (wantsUsage) {
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-harness",
				object: "chat.completion.chunk",
				model,
				choices: [],
				usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
			})}\n\n`,
		)
	}
	res.write("data: [DONE]\n\n")
	res.end()
}

async function anthropicMessages(
	res: ServerResponse,
	body: Record<string, unknown>,
): Promise<void> {
	const model = typeof body.model === "string" ? body.model : "claude-sonnet-4"
	if (body.stream !== true) {
		json(res, 200, {
			id: "msg_harness",
			type: "message",
			role: "assistant",
			model,
			content: [{ type: "text", text: PIECES.join("") }],
			stop_reason: "end_turn",
			// Anthropic excludes cache tokens from input_tokens.
			usage: {
				input_tokens: 900,
				output_tokens: 500,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 0,
			},
		})
		return
	}

	sseHead(res)
	const send = (event: string, data: unknown): void => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	}
	send("message_start", {
		type: "message_start",
		message: {
			id: "msg_harness",
			type: "message",
			role: "assistant",
			model,
			content: [],
			usage: { input_tokens: 900, output_tokens: 0, cache_read_input_tokens: 100 },
		},
	})
	send("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	})
	for (const piece of PIECES) {
		send("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: piece },
		})
		await sleep(60)
	}
	send("content_block_stop", { type: "content_block_stop", index: 0 })
	send("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { output_tokens: 500 },
	})
	send("message_stop", { type: "message_stop" })
	res.end()
}

async function geminiGenerate(
	res: ServerResponse,
	streaming: boolean,
): Promise<void> {
	const payload = (text: string, final: boolean): Record<string, unknown> => ({
		candidates: [
			{
				content: { role: "model", parts: [{ text }] },
				finishReason: final ? "STOP" : undefined,
				index: 0,
			},
		],
		// Gemini includes cached tokens inside promptTokenCount.
		usageMetadata: {
			promptTokenCount: 1000,
			candidatesTokenCount: 500,
			cachedContentTokenCount: 100,
			thoughtsTokenCount: 20,
			totalTokenCount: 1520,
		},
	})

	if (!streaming) {
		json(res, 200, payload(PIECES.join(""), true))
		return
	}

	sseHead(res)
	for (let index = 0; index < PIECES.length; index += 1) {
		const final = index === PIECES.length - 1
		res.write(`data: ${JSON.stringify(payload(PIECES[index] ?? "", final))}\n\n`)
		await sleep(60)
	}
	res.end()
}

function mjSubmit(res: ServerResponse): void {
	mjSeq += 1
	const id = String(mjSeq)
	mjPolls.set(id, 0)
	// Sequential, guessable, and echoed in three places -- which is exactly why
	// the gateway rewrites it (GW-019).
	json(res, 200, {
		code: 1,
		description: "submit success",
		result: id,
		properties: { taskId: id, discordInstanceId: id },
	})
}

function mjFetch(res: ServerResponse, id: string): void {
	const polls = (mjPolls.get(id) ?? 0) + 1
	mjPolls.set(id, polls)
	if (polls === 1) {
		json(res, 200, { id, action: "IMAGINE", status: "NOT_START", progress: "0%" })
		return
	}
	if (polls === 2) {
		json(res, 200, { id, action: "IMAGINE", status: "IN_PROGRESS", progress: "45%" })
		return
	}
	json(res, 200, {
		id,
		action: "IMAGINE",
		status: "SUCCESS",
		progress: "100%",
		imageUrl: "https://harness.invalid/image.png",
	})
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	void (async () => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`)
		const path = url.pathname
		const forced = url.searchParams.get("fail")
		const text = await readBody(req)
		const body = parseJson(text)

		if (forced) {
			json(res, Number(forced) || 500, {
				error: { message: "forced by the harness", type: "harness_error", code: forced },
			})
			return
		}

		// The harness never checks credentials, but it does prove one thing:
		// whatever the gateway sent is not the client's key.
		const seen = req.headers.authorization ?? req.headers["x-api-key"] ?? ""
		console.log(`${req.method} ${path} auth=${String(seen).slice(0, 12)}...`)

		if (path === "/v1/models") {
			json(res, 200, {
				object: "list",
				data: MODEL_LIST.map((id) => ({ id, object: "model", owned_by: "harness" })),
			})
			return
		}
		if (path === "/v1/chat/completions" || path === "/v1/completions" || path === "/v1/responses") {
			await openaiChat(res, body)
			return
		}
		if (path === "/v1/embeddings") {
			json(res, 200, {
				object: "list",
				data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
				model: "text-embedding-3-small",
				usage: { prompt_tokens: 8, total_tokens: 8 },
			})
			return
		}
		if (path === "/v1/moderations") {
			json(res, 200, { id: "modr-harness", model: "omni-moderation", results: [{ flagged: false }] })
			return
		}
		if (path === "/v1/messages") {
			await anthropicMessages(res, body)
			return
		}
		if (path === "/v1/messages/count_tokens") {
			json(res, 200, { input_tokens: 1000 })
			return
		}
		if (path.startsWith("/v1beta/models/")) {
			await geminiGenerate(res, path.includes(":streamGenerateContent"))
			return
		}
		if (path.startsWith("/mj/submit/")) {
			mjSubmit(res)
			return
		}
		if (path.startsWith("/mj/task/")) {
			const parts = path.split("/").filter((part) => part.length > 0)
			mjFetch(res, parts[2] ?? "")
			return
		}
		if (path.startsWith("/v1/images/") || path.startsWith("/v1/audio/")) {
			json(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: "https://harness.invalid/x.png" }] })
			return
		}

		json(res, 404, {
			error: { message: `the harness does not serve ${path}`, type: "invalid_request_error" },
		})
	})()
})

server.listen(PORT, () => {
	console.log(`harness listening on http://127.0.0.1:${PORT}`)
	console.log("add a channel with that base url and any non-empty key")
	console.log("append ?fail=429 to any path to force a provider error")
})
