"use client"
import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import {
	ArrowRight,
	Braces,
	CircleStop,
	Code2,
	Eraser,
	KeyRound,
	MessageSquare,
	Play,
	ShieldCheck,
	Sparkles,
} from "lucide-react"
import Link from "next/link"
import { CopyButton, useConfirm } from "../../components/interface.tsx"
import { curlExample } from "../../../lib/console/client-utils.ts"
import {
	readBoundedResponse,
	responseMessage,
} from "../../../lib/console/playground.ts"
import { useOrigin } from "../quickstart.tsx"
import {
	Callout,
	Empty,
	ErrorNote,
	PageHeader,
	Panel,
	Pill,
	formatNumber,
	httpTone,
} from "../ui.tsx"

type Result = {
	status: number
	elapsed: number
	text: string
	message: string
	tokens?: number
}
export default function PlaygroundPage() {
	const [model, setModel] = useState("")
	const [key, setKey] = useState("")
	const [prompt, setPrompt] = useState("")
	const [system, setSystem] = useState("")
	const [limit, setLimit] = useState(128)
	const [temperature, setTemperature] = useState(0.7)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const [result, setResult] = useState<Result | null>(null)
	const [tab, setTab] = useState("Message")
	const [example, setExample] = useState(false)
	const controller = useRef<AbortController | null>(null)
	const mounted = useRef(true)
	const confirming = useRef(false)
	const confirm = useConfirm()
	const origin = useOrigin()
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			controller.current?.abort()
		}
	}, [])
	const body = {
		model: model.trim() || "YOUR_MODEL",
		messages: [
			...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
			{ role: "user", content: prompt.trim() || "Hello!" },
		],
		max_tokens: limit,
		temperature,
		stream: false,
	}
	async function submit(event: FormEvent) {
		event.preventDefault()
		if (busy || confirming.current) return
		confirming.current = true
		const approved = await confirm({
			title: "Send a model request?",
			description:
				"This calls a real provider through your gateway and can consume your user and token quota. Stop only stops waiting; the provider may still finish and charge for the request.",
			action: "Send request",
		})
		confirming.current = false
		if (!approved || !mounted.current) return
		setBusy(true)
		setError("")
		setResult(null)
		setExample(false)
		const abort = new AbortController()
		controller.current = abort
		const started = performance.now()
		const timer = setTimeout(() => abort.abort(), 60_000)
		try {
			const response = await fetch("/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer " + key.trim(),
				},
				credentials: "omit",
				redirect: "error",
				cache: "no-store",
				signal: abort.signal,
				body: JSON.stringify(body),
			})
			const text = await readBoundedResponse(response)
			let parsed: unknown = null
			try {
				parsed = JSON.parse(text)
			} catch {
				/* Non-JSON errors are shown as plain text, never HTML. */
			}
			const usage = (parsed as { usage?: { total_tokens?: unknown } } | null)
				?.usage?.total_tokens
			if (mounted.current)
				setResult({
					status: response.status,
					elapsed: Math.round(performance.now() - started),
					text: parsed ? JSON.stringify(parsed, null, 2) : text,
					message: parsed ? responseMessage(parsed) : text,
					tokens: typeof usage === "number" ? usage : undefined,
				})
		} catch (cause) {
			if (mounted.current)
				setError(
					abort.signal.aborted
						? "Stopped waiting (or reached the 60-second limit). The provider may still complete the request; check usage before retrying."
						: cause instanceof Error && cause.message.includes("display limit")
							? cause.message
							: "The request could not be completed. Check your connection and gateway configuration.",
				)
		} finally {
			clearTimeout(timer)
			if (mounted.current) setBusy(false)
			controller.current = null
		}
	}
	function reset() {
		setKey("")
		setPrompt("")
		setSystem("")
		setModel("")
		setLimit(128)
		setTemperature(0.7)
		setResult(null)
		setError("")
		setExample(false)
	}
	return (
		<>
			<PageHeader
				eyebrow="DEVELOPER WORKSPACE"
				title="A little room to experiment."
				description="Try a model, inspect its response, and take the working request into your code."
				actions={
					<Link href="/console/docs" className="btn">
						<Code2 size={16} />
						API reference
						<ArrowRight size={15} />
					</Link>
				}
			/>
			<div className="playground-grid section">
				<Panel title="Compose a request" note="OpenAI compatible">
					<form
						className="playground-form"
						onSubmit={submit}
						autoComplete="off"
					>
						<div className="field">
							<label htmlFor="play-key">Gateway API key</label>
							<input
								id="play-key"
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={key}
								onChange={(event) => setKey(event.target.value)}
								placeholder="sk-…"
								required
								maxLength={512}
								disabled={busy}
							/>
							<span className="hint">
								<KeyRound size={12} /> A gateway token, not your provider key.
								Held in this page’s memory only.
							</span>
						</div>
						<div className="field">
							<label htmlFor="play-model">Model</label>
							<input
								id="play-model"
								value={model}
								onChange={(event) => setModel(event.target.value)}
								placeholder="Enter a model configured on your channel"
								maxLength={200}
								required
								disabled={busy}
							/>
							<span className="hint">
								For example, gpt-4o-mini. Availability depends on your
								providers.
							</span>
						</div>
						<div className="field">
							<label htmlFor="play-prompt">Your message</label>
							<textarea
								id="play-prompt"
								placeholder="What would you like to try?"
								rows={5}
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
								maxLength={8000}
								required
								disabled={busy}
							/>
							<span className="hint">
								{formatNumber(prompt.length)} / 8,000 characters
							</span>
						</div>
						<div className="provider-presets" style={{ margin: 0 }}>
							<button
								className="btn btn-small"
								type="button"
								disabled={busy}
								onClick={() =>
									setPrompt(
										"Explain how an API gateway works in three short bullet points.",
									)
								}
							>
								<Sparkles size={14} />
								Explain a concept
							</button>
							<button
								className="btn btn-small"
								type="button"
								disabled={busy}
								onClick={() =>
									setPrompt(
										"Write a short Python function that checks whether a string is a palindrome.",
									)
								}
							>
								<Code2 size={14} />
								Write some code
							</button>
						</div>
						<details className="disclosure">
							<summary>Request settings</summary>
							<div className="form">
								<div className="field field-wide">
									<label htmlFor="play-system">
										System instructions (optional)
									</label>
									<textarea
										id="play-system"
										rows={2}
										value={system}
										onChange={(event) => setSystem(event.target.value)}
										disabled={busy}
										maxLength={4000}
										placeholder="You are a helpful assistant."
									/>
								</div>
								<div className="field">
									<label htmlFor="play-limit">Max output tokens</label>
									<input
										id="play-limit"
										type="number"
										min={1}
										max={2048}
										required
										value={limit}
										disabled={busy}
										onChange={(event) => setLimit(Number(event.target.value))}
									/>
								</div>
								<div className="field">
									<label htmlFor="play-temp">Temperature</label>
									<input
										id="play-temp"
										type="number"
										min={0}
										max={2}
										step={0.1}
										required
										value={temperature}
										disabled={busy}
										onChange={(event) =>
											setTemperature(Number(event.target.value))
										}
									/>
								</div>
							</div>
						</details>
						<div className="form-foot">
							<button
								className="btn btn-small"
								type="button"
								disabled={busy}
								onClick={reset}
							>
								<Eraser size={15} />
								Reset & clear key
							</button>
							{busy ? (
								<button
									type="button"
									className="btn btn-danger"
									onClick={() => controller.current?.abort()}
								>
									<CircleStop size={16} />
									Stop waiting
								</button>
							) : (
								<button className="btn btn-primary" type="submit">
									<Play size={16} />
									Send request
								</button>
							)}
						</div>
						<p className="hint">
							Real requests can incur provider charges. Nothing is sent until
							you confirm.
						</p>
					</form>
				</Panel>
				<div>
					<Panel
						title="Response"
						actions={
							<button
								type="button"
								className="btn btn-small"
								onClick={() => setExample(!example)}
								aria-pressed={example}
							>
								<Code2 size={15} />
								{example ? "Hide cURL" : "View cURL"}
							</button>
						}
					>
						<div className="playground-response">
							<ErrorNote message={error} />
							{example ? (
								<div className="code-window">
									<div className="code-window-head">
										<span className="hint">Safe to copy · no key included</span>
										<CopyButton
											value={curlExample(origin, body)}
											label="Copy cURL"
											iconOnly
										/>
									</div>
									<pre className="code">{curlExample(origin, body)}</pre>
								</div>
							) : busy ? (
								<div className="empty" role="status">
									<span className="loader" />
									<h3>Waiting for your model…</h3>
									<p>
										Requests time out here after 60 seconds. You can stop
										waiting at any time.
									</p>
								</div>
							) : result ? (
								<>
									<div className="response-head">
										<Pill tone={httpTone(result.status)}>
											HTTP {result.status}
										</Pill>
										<span className="hint">
											{formatNumber(result.elapsed)} ms
											{result.tokens !== undefined
												? ` · ${formatNumber(result.tokens)} tokens`
												: ""}
										</span>
										<CopyButton
											value={tab === "JSON" ? result.text : result.message}
											label="Copy response"
											iconOnly
										/>
									</div>
									<div
										className="segmented section"
										role="group"
										aria-label="Response format"
									>
										{["Message", "JSON"].map((name) => (
											<button
												key={name}
												type="button"
												className={tab === name ? "active" : ""}
												aria-pressed={tab === name}
												onClick={() => setTab(name)}
											>
												{name}
											</button>
										))}
									</div>
									<div
										className={
											"response-output" + (tab === "JSON" ? " mono" : "")
										}
									>
										{tab === "JSON" ? result.text : result.message}
									</div>
								</>
							) : (
								<Empty>
									<span>
										<MessageSquare size={24} />
										<Braces size={24} />
									</span>
									<h3>Make something happen</h3>
									<p>
										Your model’s response will appear here. Add a gateway key
										and a configured model to send your first request.
									</p>
								</Empty>
							)}
						</div>
					</Panel>
					<p className="privacy-note">
						<ShieldCheck size={16} />
						Keys, prompts, and responses are not saved in browser storage.
						Copied cURL uses an environment variable instead of your key.
					</p>
				</div>
			</div>
			<Callout tone="warn">
				An enabled provider channel, a valid gateway token, and sufficient user
				balance are required. If a request fails, inspect its response before
				sending it again.
			</Callout>
		</>
	)
}
