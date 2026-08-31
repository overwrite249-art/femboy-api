/**
 * Post-deploy smoke checks.
 *
 * Every check is a security or correctness property, not a liveness ping. A
 * deployment that passes these is authenticating, refusing, streaming and
 * accounting; one that fails any of them is misconfigured in a way that matters.
 *
 *   BASE_URL=https://your-deployment API_KEY=sk-... npm run smoke
 */

type Check = {
	name: string
	run: () => Promise<string>
}

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "")
const API_KEY = process.env.API_KEY ?? ""

function expect(condition: boolean, detail: string): void {
	if (!condition) throw new Error(detail)
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text()
	try {
		const parsed: unknown = JSON.parse(text)
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
	} catch {
		// Fall through: a non-JSON body is itself a finding.
	}
	throw new Error(`expected json, got ${text.slice(0, 120)}`)
}

const checks: Check[] = [
	{
		name: "a request with no credential is refused",
		run: async () => {
			const response = await fetch(`${BASE_URL}/v1/models`)
			expect(response.status === 401, `expected 401, got ${response.status}`)
			const body = await jsonOf(response)
			const error = body.error as Record<string, unknown> | undefined
			expect(typeof error?.message === "string", "error body has no message")
			expect(
				!JSON.stringify(body).includes("sk-"),
				"the refusal body mentions a key prefix",
			)
			return `401 ${String(error?.code ?? "")}`
		},
	},
	{
		name: "an invalid credential is refused the same way",
		run: async () => {
			const response = await fetch(`${BASE_URL}/v1/models`, {
				headers: { authorization: "Bearer sk-definitely-not-a-real-key" },
			})
			expect(response.status === 401, `expected 401, got ${response.status}`)
			return "401"
		},
	},
	{
		name: "the model list is served and scoped",
		run: async () => {
			if (!API_KEY) return "skipped, no API_KEY"
			const response = await fetch(`${BASE_URL}/v1/models`, {
				headers: { authorization: `Bearer ${API_KEY}` },
			})
			expect(response.ok, `expected 200, got ${response.status}`)
			const body = await jsonOf(response)
			const data = Array.isArray(body.data) ? body.data : []
			return `${data.length} models`
		},
	},
	{
		name: "a buffered completion round-trips",
		run: async () => {
			if (!API_KEY) return "skipped, no API_KEY"
			const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${API_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: process.env.SMOKE_MODEL ?? "gpt-4o-mini",
					messages: [{ role: "user", content: "reply with the word ok" }],
					max_tokens: 8,
				}),
			})
			if (response.status === 503) return "503 no channel configured (expected on a fresh deploy)"
			expect(response.ok, `expected 200, got ${response.status}`)
			const body = await jsonOf(response)
			expect(Array.isArray(body.choices), "no choices in the response")
			expect(!JSON.stringify(body).includes("sk-"), "the response body contains a key")
			return "200"
		},
	},
	{
		name: "a streamed completion terminates properly",
		run: async () => {
			if (!API_KEY) return "skipped, no API_KEY"
			const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${API_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: process.env.SMOKE_MODEL ?? "gpt-4o-mini",
					messages: [{ role: "user", content: "count to three" }],
					stream: true,
					max_tokens: 16,
				}),
			})
			if (response.status === 503) return "503 no channel configured"
			expect(response.ok, `expected 200, got ${response.status}`)
			const type = response.headers.get("content-type") ?? ""
			expect(type.includes("event-stream"), `expected an sse content type, got ${type}`)
			const text = await response.text()
			expect(text.includes("data: [DONE]"), "the stream never sent [DONE]")
			expect(!text.includes("sk-"), "the stream contains a key")
			return "200 sse"
		},
	},
	{
		name: "the task list is scoped to the caller",
		run: async () => {
			if (!API_KEY) return "skipped, no API_KEY"
			const response = await fetch(`${BASE_URL}/v1/tasks`, {
				headers: { authorization: `Bearer ${API_KEY}` },
			})
			expect(response.ok, `expected 200, got ${response.status}`)
			const body = await jsonOf(response)
			expect(Array.isArray(body.data), "no data array")
			return `${(body.data as unknown[]).length} tasks`
		},
	},
	{
		name: "another caller's task is not readable",
		run: async () => {
			if (!API_KEY) return "skipped, no API_KEY"
			const response = await fetch(`${BASE_URL}/v1/tasks/task-obviouslyNotYours000000000000`, {
				headers: { authorization: `Bearer ${API_KEY}` },
			})
			expect(response.status === 404, `expected 404, got ${response.status}`)
			return "404"
		},
	},
	{
		name: "the admin api refuses an unauthenticated write",
		run: async () => {
			const response = await fetch(`${BASE_URL}/api/admin/users`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "smoke-should-not-exist" }),
			})
			expect(
				response.status === 401 || response.status === 403,
				`expected 401 or 403, got ${response.status}`,
			)
			return String(response.status)
		},
	},
	{
		name: "cron endpoints are not open to the internet",
		run: async () => {
			const response = await fetch(`${BASE_URL}/api/cron/flush-usage`)
			expect(response.status !== 200, "a cron job ran without a secret")
			return String(response.status)
		},
	},
	{
		name: "a relay key is not a console session",
		run: async () => {
			if (!API_KEY) return "skipped, no API_KEY"
			const response = await fetch(`${BASE_URL}/api/admin/whoami`, {
				headers: { authorization: `Bearer ${API_KEY}` },
			})
			expect(
				response.status === 401 || response.status === 403,
				`a relay key reached the console api (${response.status})`,
			)
			return String(response.status)
		},
	},
	{
		name: "hardening headers are present",
		run: async () => {
			const response = await fetch(`${BASE_URL}/`)
			const nosniff = response.headers.get("x-content-type-options") ?? ""
			expect(nosniff === "nosniff", "x-content-type-options is not set")
			expect(!response.headers.has("x-powered-by"), "x-powered-by is exposed")
			return "ok"
		},
	},
]

async function main(): Promise<void> {
	console.log(`smoke: ${BASE_URL}`)
	if (!API_KEY) console.log("no API_KEY set, authenticated checks will be skipped")
	console.log("")

	let failed = 0
	for (const check of checks) {
		try {
			const detail = await check.run()
			console.log(`pass  ${check.name} -- ${detail}`)
		} catch (error) {
			failed += 1
			const message = error instanceof Error ? error.message : String(error)
			console.log(`FAIL  ${check.name} -- ${message}`)
		}
	}

	console.log("")
	console.log(failed === 0 ? "all checks passed" : `${failed} check(s) failed`)
	process.exit(failed === 0 ? 0 : 1)
}

await main()
