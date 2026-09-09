import Link from "next/link"
import { ArrowRight, ArrowUpRight, ShieldCheck } from "lucide-react"
import { Brand, ThemePicker } from "../components/interface.tsx"
export const metadata = { title: "Deployment guide · femboy api" }
export default function SetupGuide() {
	return (
		<>
			<nav className="public-nav" aria-label="Site navigation">
				<Link href="/" aria-label="femboy api home">
					<Brand />
				</Link>
				<div className="button-row">
					<ThemePicker />
					<Link className="btn" href="/console">
						Open console <ArrowRight size={15} />
					</Link>
				</div>
			</nav>
			<main className="guide">
				<div className="page-heading">
					<div>
						<span className="eyebrow">DEPLOYMENT GUIDE</span>
						<h1>Four steps to a working deployment.</h1>
						<p>
							Configure storage and secrets, create the first administrator,
							connect the scheduler, then verify with a real request. Secrets
							belong in your hosting provider’s environment, not in the
							repository.
						</p>
					</div>
				</div>
				<ol className="guide-steps">
					<li>
						<h2>Set storage and secrets</h2>
						<p>
							Set your MongoDB connection and required server secrets in your
							hosting provider’s environment settings. Use{" "}
							<code>COORDINATION_BACKEND=mongo</code> and a stable HTTPS{" "}
							<code>PUBLIC_BASE_URL</code>. No Redis account is required.
						</p>
						<a
							className="subtle-link"
							href="https://github.com/overwrite249-art/femboy-api#readme"
							target="_blank"
							rel="noreferrer"
						>
							Environment reference <ArrowUpRight size={15} />
						</a>
					</li>
					<li>
						<h2>Establish your root account</h2>
						<p>
							Run the documented <code>npm run bootstrap:admin</code> command
							from a trusted machine. Your root account is created out of band,
							so public visitors cannot claim the first administrator.
						</p>
						<Link className="subtle-link" href="/login">
							Sign in securely <ArrowRight size={15} />
						</Link>
					</li>
					<li>
						<h2>Bring a scheduler key</h2>
						<p>
							Sign in to cron-job.org, open <strong>Settings</strong>, and
							generate an <strong>API key</strong>. The console uses it once to
							configure the gateway’s eight maintenance jobs.
						</p>
						<a
							className="subtle-link"
							href="https://console.cron-job.org"
							target="_blank"
							rel="noreferrer"
						>
							Open cron-job.org <ArrowUpRight size={15} />
						</a>
					</li>
					<li>
						<h2>Connect, then verify</h2>
						<p>
							Sign in as root and open Deployment in the console. Configure the
							scheduler, inspect execution history, and add your provider
							channels. Fund a user balance and issue a gateway key before
							making a request.
						</p>
						<Link className="subtle-link" href="/console/setup">
							Open secure deployment <ArrowRight size={15} />
						</Link>
					</li>
				</ol>
				<div className="hero-actions">
					<Link className="btn btn-primary" href="/console/setup">
						Finish setup in the console <ArrowRight size={16} />
					</Link>
					<a
						className="btn"
						href="https://docs.cron-job.org/rest-api.html"
						target="_blank"
						rel="noreferrer"
					>
						Scheduler documentation <ArrowUpRight size={15} />
					</a>
				</div>
				<p className="privacy-note">
					<ShieldCheck size={17} />
					Never commit API keys, database passwords, or environment files.
					Configure secrets through your hosting provider—not through repository
					files.
				</p>
			</main>
		</>
	)
}
