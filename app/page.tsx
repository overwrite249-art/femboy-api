import Link from "next/link"
import {
	ArrowRight,
	ArrowUpRight,
	Boxes,
	Code2,
	ShieldCheck,
	Sparkles,
	Wallet,
} from "lucide-react"
import { Brand, ThemePicker } from "./components/interface.tsx"
const SAMPLE = `import OpenAI from "openai";\n\nconst ai = new OpenAI({\n  baseURL: process.env.GATEWAY_URL + "/v1",\n  apiKey: process.env.FEMBOY_API_KEY,\n});\n\nconst reply = await ai.chat.completions.create({\n  model: "YOUR_MODEL",\n  messages: [{\n    role: "user",\n    content: "Let’s make something great."\n  }]\n});`
export default function LandingPage() {
	return (
		<>
			<nav className="public-nav" aria-label="Site navigation">
				<Link href="/" aria-label="femboy api home">
					<Brand />
				</Link>
				<div className="button-row">
					<Link href="/setup" className="subtle-link">
						Deployment guide
					</Link>
					<ThemePicker />
					<Link href="/login" className="btn">
						Sign in <ArrowRight size={15} />
					</Link>
				</div>
			</nav>
			<main className="landing">
				<section className="landing-hero">
					<div>
						<span className="landing-label">
							<Sparkles size={14} />
							Open source. Independently yours.
						</span>
						<h1>
							Your models.
							<br />
							Your rules.
							<br />
							<span>One beautiful API.</span>
						</h1>
						<p>
							Bring your favorite AI providers together. Route requests, manage
							access, and understand every token—from a workspace that’s
							actually yours.
						</p>
						<div className="hero-actions">
							<Link href="/console" className="btn btn-primary">
								Open your console <ArrowRight size={16} />
							</Link>
							<a
								href="https://github.com/overwrite249-art/femboy-api"
								className="btn"
								target="_blank"
								rel="noreferrer"
							>
								<Code2 size={17} />
								Explore the source
							</a>
						</div>
						<p className="hint">
							Self-hosted on Vercel + MongoDB. No separate Redis account
							required.
						</p>
					</div>
					<div className="landing-code">
						<div className="code-window-head">
							<span className="window-dots">
								<span />
								<span />
								<span />
							</span>
							<span>your-next-idea.ts</span>
							<Code2 size={15} />
						</div>
						<pre className="code">
							<code>{SAMPLE}</code>
						</pre>
						<div className="response-line">
							<ShieldCheck size={16} />
							<span>
								Your credentials stay on your server.
								<br />
								Your possibilities stay open.
							</span>
						</div>
					</div>
				</section>
				<section>
					<div className="landing-section-head">
						<h2>
							Less juggling.
							<br />
							More building.
						</h2>
						<p>
							A control plane for your providers, your applications, and
							everything in between.
						</p>
					</div>
					<div className="grid-3">
						<article className="feature">
							<Boxes />
							<h3>Connect your favorites</h3>
							<p>
								OpenAI, Anthropic, Gemini, and compatible providers.
								Health-aware routing and weighted load balancing, behind a
								familiar API.
							</p>
							<Link className="subtle-link" href="/console/channels">
								Explore channels <ArrowUpRight size={15} />
							</Link>
						</article>
						<article className="feature">
							<Wallet />
							<h3>Keep spending deliberate</h3>
							<p>
								Per-user balances, scoped keys, and request-level usage. Quota
								is reserved before a call and settled against recorded usage.
							</p>
							<Link className="subtle-link" href="/console/usage">
								Understand usage <ArrowUpRight size={15} />
							</Link>
						</article>
						<article className="feature">
							<ShieldCheck />
							<h3>Access with intention</h3>
							<p>
								Role-aware controls, encrypted provider credentials, and gateway
								keys stored as digests. No public first-admin takeover.
							</p>
							<Link className="subtle-link" href="/setup">
								Deploy thoughtfully <ArrowUpRight size={15} />
							</Link>
						</article>
					</div>
				</section>
				<footer className="public-footer">
					<Brand />
					<span>No provider affiliation. Bring your own accounts.</span>
					<Link href="/setup">
						Deployment guide <ArrowRight size={13} />
					</Link>
				</footer>
			</main>
		</>
	)
}
