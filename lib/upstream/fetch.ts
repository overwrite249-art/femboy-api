/**
 * The only way this gateway talks to an upstream.
 *
 * Everything here exists because an upstream is not trusted to behave:
 *
 *  - It may never send headers. A request that hangs forever holds a serverless
 *    invocation open until the platform kills it, and the caller is billed for
 *    the wait (GW-027).
 *  - It may send headers and then stall mid-body. Streaming responses have no
 *    content length, so only an idle timer can tell a slow model from a dead
 *    connection.
 *  - It may send an unbounded body. Buffering whatever arrives is how a
 *    compressed response becomes an out-of-memory kill (GW-008).
 *  - The client may disconnect first. Without propagation the upstream call
 *    continues, consuming tokens nobody will read and leaving a reservation
 *    unsettled (GW-004).
 */

import { config } from "../config/env.ts"
import { malformedUpstreamBody, ssrfBlocked, upstreamTimeout } from "../http/errors.ts"
import { assertRedirectAllowed, assertUpstreamUrlAllowed } from "./ssrf.ts"
import { createPinnedDispatcher } from "./dispatcher.ts"

export type UpstreamFetchOptions = {
	/** The client's signal. Aborting it aborts the upstream call. */
	signal?: AbortSignal | null
	/** Time allowed for response headers to arrive. */
	headerTimeoutMs?: number
	/** Time allowed between body chunks. */
	idleTimeoutMs?: number
	/** Hard cap on the response body. */
	maxBytes?: number
	/** How many redirects to re-validate and follow. */
	maxRedirects?: number
	/** Absolute lifetime, not reset by body activity or redirects. */
	totalTimeoutMs?: number
}

export type GuardStreamOptions = {
	maxBytes: number
	idleMs: number
	onClose?: () => void
}

/**
 * Wraps a body so it cannot stall or overrun.
 *
 * The idle timer is armed per read rather than for the whole stream: a long
 * generation is legitimate, a long silence is not.
 */
export function guardStream(
	source: ReadableStream<Uint8Array>,
	options: GuardStreamOptions,
): ReadableStream<Uint8Array> {
	const reader = source.getReader()
	let total = 0
	let finished = false
	const finish = () => {
		if (finished) return
		finished = true
		options.onClose?.()
	}

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				const read = reader.read()
				const next =
					options.idleMs > 0
						? await Promise.race([
								read,
								new Promise<never>((_, reject) => {
									timer = setTimeout(
										() => reject(upstreamTimeout(`upstream stalled for ${options.idleMs}ms`)),
										options.idleMs,
									)
								}),
						  ])
						: await read

				if (next.done) {
					finish()
					controller.close()
					return
				}

				const chunk = next.value
				total += chunk.byteLength
				if (options.maxBytes > 0 && total > options.maxBytes) {
					void reader.cancel().catch(() => undefined)
					finish()
					controller.error(
						malformedUpstreamBody(
							`upstream response exceeded ${options.maxBytes} bytes`,
						),
					)
					return
				}
				controller.enqueue(chunk)
			} catch (error) {
				void reader.cancel().catch(() => undefined)
				finish()
				controller.error(error)
			} finally {
				if (timer) clearTimeout(timer)
			}
		},
		cancel(reason) {
			void reader.cancel(reason).catch(() => undefined)
			finish()
		},
	})
}

/** Reads a whole body with the same cap, for non-streaming responses. */
export async function readCappedText(
	response: Response,
	maxBytes = config.maxUpstreamResponseBytes,
): Promise<string> {
	if (!response.body) return ""
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (maxBytes > 0 && total > maxBytes) {
				await reader.cancel().catch(() => undefined)
				throw malformedUpstreamBody(`upstream response exceeded ${maxBytes} bytes`)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock?.()
	}
	const joined = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		joined.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(joined)
}

/**
 * Performs a validated, bounded upstream request.
 *
 * Redirects are followed manually so every hop passes the SSRF guard again.
 */
export async function upstreamFetch(
	rawUrl: string,
	init: RequestInit = {},
	options: UpstreamFetchOptions = {},
): Promise<Response> {
	const headerTimeoutMs = options.headerTimeoutMs ?? config.upstreamHeaderTimeoutMs
	const idleTimeoutMs = options.idleTimeoutMs ?? config.streamingIdleTimeoutMs
	const maxBytes = options.maxBytes ?? config.maxUpstreamResponseBytes
	const maxRedirects = options.maxRedirects ?? 3
	const deadline = Date.now() + Math.max(1, options.totalTimeoutMs ?? config.upstreamRequestTimeoutMs)
	const signals = [options.signal, init.signal].filter((signal): signal is AbortSignal => !!signal)
	const clientSignal = signals.length ? AbortSignal.any(signals) : undefined
	clientSignal?.throwIfAborted()

	let target = await assertUpstreamUrlAllowed(rawUrl)
	let redirects = 0
	let requestInit = { ...init }

	for (;;) {
		const controller = new AbortController()
		const abortUpstream = (reason?: unknown) => controller.abort(reason)
		const dispatcher = createPinnedDispatcher(target)
		const onAbort = () => abortUpstream(clientSignal?.reason)

		// A client that goes away takes the upstream call with it.
		if (clientSignal) {
			if (clientSignal.aborted) onAbort()
			else clientSignal.addEventListener("abort", onAbort, { once: true })
		}
		const totalTimer = setTimeout(() => abortUpstream(upstreamTimeout("upstream request timed out")),
			Math.max(1, deadline - Date.now()))
		const cleanup = () => {
			clearTimeout(totalTimer)
			clientSignal?.removeEventListener("abort", onAbort)
			void dispatcher.destroy().catch(() => {})
		}

		const headerTimer =
			headerTimeoutMs > 0
				? setTimeout(() => abortUpstream(upstreamTimeout("upstream headers timed out")), headerTimeoutMs)
				: undefined

		let response: Response
		try {
			controller.signal.throwIfAborted()
			response = await fetch(target.url.toString(), {
				...requestInit,
				signal: controller.signal,
				dispatcher,
				// Handled below so each hop is re-validated.
				redirect: "manual",
			} as RequestInit)
		} catch (error) {
			cleanup()
			if (clientSignal?.aborted) throw error
			if (controller.signal.aborted) throw upstreamTimeout("upstream headers timed out")
			throw error
		} finally {
			if (headerTimer) clearTimeout(headerTimer)
		}

		const location = response.headers.get("location")
		const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && location
		if (isRedirect) {
			void response.body?.cancel().catch(() => undefined)
			cleanup()
			if (redirects >= maxRedirects) throw malformedUpstreamBody("too many upstream redirects")
			redirects += 1
			const next = new URL(location, target.url)
			// Replaying a provider key or prompt to a new origin is credential
			// exfiltration even if both addresses are publicly routable.
			if (next.origin !== target.url.origin) throw ssrfBlocked("cross-origin upstream redirects are disabled")
			const method = (requestInit.method ?? "GET").toUpperCase()
			if ((response.status === 303 && method !== "HEAD") ||
				([301, 302].includes(response.status) && method === "POST")) {
				const headers = new Headers(requestInit.headers)
				for (const name of ["content-type", "content-length", "content-encoding", "transfer-encoding"]) headers.delete(name)
				requestInit = { ...requestInit, method: "GET", body: undefined, headers }
			} else if (requestInit.body instanceof ReadableStream) {
				throw malformedUpstreamBody("cannot replay a streamed request body across a redirect")
			}
			target = await assertRedirectAllowed(location, target.url)
			continue
		}

		if (!response.body) {
			cleanup()
			return response
		}

		return new Response(guardStream(response.body, { maxBytes, idleMs: idleTimeoutMs, onClose: cleanup }), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		})
	}
}
