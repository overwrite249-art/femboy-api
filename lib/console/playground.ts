/** Limit untrusted responses before rendering or copying them in the console. */
export const PLAYGROUND_RESPONSE_LIMIT = 1_048_576
export async function readBoundedResponse(
	response: Response,
	maxBytes = PLAYGROUND_RESPONSE_LIMIT,
): Promise<string> {
	if (!response.body) return ""
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let length = 0
	let text = ""
	try {
		for (;;) {
			const { value, done } = await reader.read()
			if (done) break
			length += value.byteLength
			if (length > maxBytes) {
				await reader.cancel()
				throw new Error(
					"Response exceeded the 1 MiB playground display limit. Use an SDK for larger responses.",
				)
			}
			text += decoder.decode(value, { stream: true })
		}
		return text + decoder.decode()
	} finally {
		reader.releaseLock()
	}
}
export function responseMessage(value: unknown): string {
	if (!value || typeof value !== "object") return ""
	const data = value as {
		choices?: { message?: { content?: unknown } }[]
		error?: { message?: unknown }
	}
	const message = data.choices?.[0]?.message?.content
	if (typeof message === "string") return message
	if (typeof data.error?.message === "string") return data.error.message
	return "This response has no text message. Open the JSON tab to inspect its structure."
}
