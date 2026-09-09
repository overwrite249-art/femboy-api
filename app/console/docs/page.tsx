"use client"
import Link from "next/link"
import {
	ArrowRight,
	ArrowUpRight,
	BookOpen,
	KeyRound,
	Play,
	ShieldCheck,
} from "lucide-react"
import { CopyButton } from "../../components/interface.tsx"
import { Quickstart, useOrigin } from "../quickstart.tsx"
import { Callout, PageHeader, Panel, Pill } from "../ui.tsx"
const ENDPOINTS = [
	[
		"POST",
		"/v1/chat/completions",
		"OpenAI-compatible chat completions. Supports streaming and tool calls on compatible models.",
	],
	[
		"POST",
		"/v1/responses",
		"OpenAI Responses dialect, translated through the gateway’s provider adapters.",
	],
	[
		"POST",
		"/v1/messages",
		"Anthropic Messages dialect. Use x-api-key with your gateway token.",
	],
	[
		"POST",
		"/v1beta/models/{model}:generateContent",
		"Gemini content generation. Use x-goog-api-key with your gateway token.",
	],
	[
		"GET",
		"/v1/models",
		"List the gateway’s available model catalogue for your authenticated identity.",
	],
]
export default function DocsPage() {
	const origin = useOrigin()
	return (
		<>
			<PageHeader
				eyebrow="Reference"
				title="API reference"
				description="Endpoints, parameters and examples, from a first request to production integration."
				actions={
					<Link className="btn btn-primary" href="/console/playground">
						<Play size={16} />
						Open playground
					</Link>
				}
			/>
			<div className="docs-layout">
				<div>
					<section className="docs-section" id="quickstart">
						<h2>First request</h2>
						<p>
							Connect an enabled channel, fund the token owner’s balance, and
							issue a gateway key. Set the key in your shell, choose a model
							configured on your channel, and adapt one of these examples.
							JavaScript and Python examples use the OpenAI SDK.
						</p>
						<Quickstart />
					</section>
					<section className="docs-section" id="authentication">
						<h2>Keys, not console sessions</h2>
						<Panel title="API authentication" note="Keep keys on the server">
							<div className="endpoint-box">
								<label>Your base URL</label>
								<div>
									<code>{origin}/v1</code>
									<CopyButton
										value={origin + "/v1"}
										label="Copy API base URL"
										iconOnly
									/>
								</div>
							</div>
							<p className="setup-copy" style={{ marginTop: 20 }}>
								Send <code>Authorization: Bearer $FEMBOY_API_KEY</code> for
								OpenAI-compatible requests. Console cookies do not authenticate
								model calls. Never place API keys in public client bundles,
								URLs, source control, or screenshots.
							</p>
							<Link className="subtle-link" href="/console/tokens">
								<KeyRound size={16} />
								Manage gateway keys <ArrowRight size={15} />
							</Link>
						</Panel>
					</section>
					<section className="docs-section" id="endpoints">
						<h2>One gateway. Familiar endpoints.</h2>
						<p>
							Support depends on the selected model and provider. Configure the
							channel’s base URL for that provider; don’t assume every provider
							supports every capability.
						</p>
						<div className="panel">
							{ENDPOINTS.map(([method, path, description]) => (
								<div className="endpoint-row" key={path}>
									<Pill tone={method === "GET" ? "ok" : "info"}>{method}</Pill>
									<code>{path}</code>
									<p>{description}</p>
								</div>
							))}
						</div>
					</section>
					<section className="docs-section" id="errors">
						<h2>When a request needs attention</h2>
						<Panel title="Common responses">
							<table>
								<thead>
									<tr>
										<th>Status</th>
										<th>What to check</th>
									</tr>
								</thead>
								<tbody>
									{[
										["401", "Missing, expired, or invalid gateway key."],
										[
											"403",
											"Your token, user, IP scope, or model scope does not allow this request.",
										],
										[
											"402 / quota errors",
											"Check the owner’s balance and the token’s remaining quota.",
										],
										[
											"429",
											"Slow down. Respect Retry-After when present and retry with backoff.",
										],
										[
											"502 / 503",
											"Check provider channel configuration and upstream availability.",
										],
										[
											"504",
											"The provider took too long. Check usage before retrying a billable request.",
										],
									].map(([status, text]) => (
										<tr key={status}>
											<td className="mono">{status}</td>
											<td>{text}</td>
										</tr>
									))}
								</tbody>
							</table>
						</Panel>
					</section>
					<section className="docs-section" id="production">
						<h2>A few good production habits</h2>
						<Callout tone="ok">
							Use separate scoped keys per application. Set quotas and expiry,
							rotate deliberately, and keep provider credentials only in channel
							configuration.
						</Callout>
						<p>
							For longer or streaming requests, use an SDK rather than the
							browser playground. The playground intentionally caps output at
							2,048 tokens, waits up to 60 seconds, and limits displayed
							responses to 1 MiB.
						</p>
						<p>
							Aborting a client request does not guarantee the upstream provider
							stops charging. Keep request IDs for troubleshooting; never log
							request headers that contain credentials.
						</p>
					</section>
				</div>
				<aside className="docs-aside">
					<Panel title="On this page">
						<nav className="docs-toc" aria-label="Reference sections">
							<a href="#quickstart">01 · Quickstart</a>
							<a href="#authentication">02 · Authentication</a>
							<a href="#endpoints">03 · Endpoints</a>
							<a href="#errors">04 · Troubleshooting</a>
							<a href="#production">05 · Production habits</a>
						</nav>
					</Panel>
					<div className="feature" style={{ marginTop: 20 }}>
						<BookOpen />
						<h3>Go a little deeper</h3>
						<p>
							Explore the source, deployment notes, and security documentation.
						</p>
						<a
							className="subtle-link"
							href="https://github.com/overwrite249-art/femboy-api"
							target="_blank"
							rel="noreferrer"
						>
							View repository <ArrowUpRight size={15} />
						</a>
						<Link className="subtle-link" href="/setup">
							Deployment guide <ArrowRight size={15} />
						</Link>
					</div>
					<p className="privacy-note">
						<ShieldCheck size={16} />
						No provider affiliation. Bring your own accounts and review their
						terms.
					</p>
				</aside>
			</div>
		</>
	)
}
