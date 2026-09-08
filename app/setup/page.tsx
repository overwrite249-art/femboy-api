import Link from "next/link"

export const metadata = { title: "Deployment setup · femboy api" }

export default function SetupGuide() {
	return (
		<main className="hero setup-guide">
			<Link className="link" href="/">← femboy api</Link>
			<h1>Finish your deployment.</h1>
			<p>Bring your infrastructure, keep your keys private, and connect the maintenance scheduler.</p>
			<ol className="setup-guide-steps">
				<li><h2>Configure storage and secrets</h2><p>Set MongoDB, Upstash Redis, and the required server secrets in your hosting provider&apos;s environment settings. Use a stable HTTPS <code>PUBLIC_BASE_URL</code>.</p></li>
				<li><h2>Create your root account</h2><p>The operator must run the documented <code>npm run bootstrap:admin</code> command from a trusted machine. Public visitors cannot claim the first administrator account.</p></li>
				<li><h2>Get a cron-job.org API key</h2><p>Sign in at <a className="link" href="https://console.cron-job.org" target="_blank" rel="noreferrer">cron-job.org</a>, open <strong>Settings</strong>, and generate an <strong>API key</strong>. It is required by the automatic scheduler setup.</p></li>
				<li><h2>Connect and verify</h2><p>Sign in as root and open Setup in the console. Enter the API key to create the eight jobs, then check their execution history. Add your provider channels in the console when ready.</p></li>
			</ol>
			<div className="hero-actions">
				<Link className="btn btn-primary" href="/console/setup">Open secure setup</Link>
				<a className="btn" href="https://docs.cron-job.org/rest-api.html" target="_blank" rel="noreferrer">API key documentation ↗</a>
			</div>
			<p className="hint">Never commit API keys, database passwords, or environment files to your repository.</p>
		</main>
	)
}