import Link from "next/link"

const SAMPLE = [
	"curl https://your-gateway.vercel.app/v1/chat/completions \\",
	'  -H "Authorization: Bearer sk-..." \\',
	'  -H "Content-Type: application/json" \\',
	'  -d \'{"model":"claude-sonnet-4","messages":[{"role":"user","content":"hi"}]}\'',
].join("\n")

export default function LandingPage() {
	return (
		<main className="hero">
			<div className="brand">
				<div className="brand-mark" />
				<div>
					<div className="brand-name">femboy api</div>
					<div className="brand-sub">self-hosted AI gateway</div>
				</div>
			</div>

			<h1>One key, every model, your own infrastructure.</h1>

			<p>
				A gateway that accepts OpenAI, Anthropic and Gemini requests, routes them
				across your provider accounts with health-aware load balancing, and bills
				every token to the account that spent it. Runs on Vercel with MongoDB and
				Upstash Redis.
			</p>

			<div className="hero-actions">
				<Link className="btn btn-primary" href="/console">
					Open console
				</Link>
				<Link className="btn" href="/login">
					Sign in
				</Link>
				<a
					className="btn"
					href="https://github.com/overwrite249-art/femboy-api"
					rel="noreferrer"
				>
					Source
				</a>
			</div>

			<pre className="code">{SAMPLE}</pre>

			<div className="grid-3">
				<div className="feature">
					<h3>Three dialects, one surface</h3>
					<p>
						Send an Anthropic request and have it served by OpenAI, or the reverse.
						Streaming is translated frame by frame, including tool calls.
					</p>
				</div>
				<div className="feature">
					<h3>Accounting that survives concurrency</h3>
					<p>
						Quota is reserved atomically before the request and settled against real
						usage after, so parallel calls cannot overspend a balance.
					</p>
				</div>
				<div className="feature">
					<h3>Keys that are never readable</h3>
					<p>
						Relay keys are stored as peppered digests and provider keys are sealed
						with AES-GCM. Neither can be displayed again, including to you.
					</p>
				</div>
			</div>

			<p className="hint">
				No affiliation with any model provider. Bring your own provider accounts.
			</p>
		</main>
	)
}
