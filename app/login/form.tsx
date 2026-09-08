"use client"

import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import {
	ArrowLeft,
	ArrowRight,
	Boxes,
	Eye,
	EyeOff,
	Code2,
	ShieldCheck,
	Wallet,
} from "lucide-react"
import { Brand, ThemePicker } from "../components/interface.tsx"
import { safeRedirect } from "../../lib/http/redirect.ts"

export default function LoginForm({
	githubEnabled,
}: {
	githubEnabled: boolean
}) {
	const router = useRouter()
	const params = useSearchParams()
	const next = safeRedirect(params.get("redirect"))

	const [username, setUsername] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [checking, setChecking] = useState(true)
	const [visible, setVisible] = useState(false)

	useEffect(() => {
		let cancelled = false
		fetch("/api/auth/session", { credentials: "same-origin" })
			.then(async (response) => {
				if (cancelled || !response.ok) return
				const body = (await response.json()) as { user?: unknown }
				if (body.user) router.replace(next)
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setChecking(false)
			})
		return () => {
			cancelled = true
		}
	}, [router, next])

	async function submit(event: FormEvent) {
		event.preventDefault()
		if (busy || checking) return
		setBusy(true)
		setError("")
		try {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				redirect: "error",
				body: JSON.stringify({ username, password }),
			})
			if (response.ok) {
				router.replace(next)
				return
			}
			const text = await response.text()
			let message = "these credentials are not valid"
			try {
				const parsed = JSON.parse(text) as { error?: { message?: string } }
				if (parsed.error?.message) message = parsed.error.message
			} catch {
				// keep the generic message
			}
			setError(message)
		} catch {
			setError("the gateway could not be reached")
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="auth-shell">
			<aside className="auth-story">
				<Link href="/">
					<Brand />
				</Link>
				<div className="auth-story-copy">
					<span className="launch-badge">YOUR AI, CONNECTED</span>
					<h2>
						A home for your models.
						<br />
						<span>A head start for your ideas.</span>
					</h2>
					<p>
						Your providers, your applications, and your next big thing. All
						connected through one gateway.
					</p>
					<div className="auth-features">
						<span>
							<Boxes size={19} />
							Bring your favorite model providers
						</span>
						<span>
							<Wallet size={19} />
							Keep usage and balances in view
						</span>
						<span>
							<ShieldCheck size={19} />
							Stay in control of every key
						</span>
					</div>
				</div>
				<p className="hint">
					Self-hosted. Provider-independent. Intentionally yours.
				</p>
			</aside>
			<main className="auth">
				<div className="auth-tools">
					<Link className="subtle-link" href="/">
						<ArrowLeft size={16} />
						Back to home
					</Link>
					<ThemePicker />
				</div>
				<form className="auth-card" onSubmit={submit}>
					<Brand />
					<div>
						<span className="eyebrow">YOUR WORKSPACE AWAITS</span>
						<h1 className="auth-title">Welcome back.</h1>
					</div>
					<p>Sign in to manage your gateway.</p>
					{error ? (
						<div className="auth-error" role="alert">
							{error}
						</div>
					) : null}
					<div className="field">
						<label htmlFor="username">Username</label>
						<input
							id="username"
							name="username"
							autoComplete="username"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
							required
							maxLength={64}
							placeholder="Your username"
						/>
					</div>
					<div className="field">
						<label htmlFor="password">Password</label>
						<div className="password-field">
							<input
								id="password"
								name="password"
								type={visible ? "text" : "password"}
								autoComplete="current-password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								required
								maxLength={1024}
								placeholder="Enter your password"
							/>
							<button
								className="icon-btn"
								type="button"
								aria-label={visible ? "Hide password" : "Show password"}
								aria-pressed={visible}
								onClick={() => setVisible(!visible)}
							>
								{visible ? <EyeOff size={18} /> : <Eye size={18} />}
							</button>
						</div>
					</div>
					<button
						className="btn btn-primary"
						type="submit"
						disabled={busy || checking}
					>
						{busy
							? "Signing in…"
							: checking
								? "Checking session…"
								: "Sign in to your console"}
						<ArrowRight size={17} />
					</button>
					{githubEnabled ? (
						<>
							<div className="auth-divider">or continue with</div>
							<a
								className="btn"
								href={"/api/auth/github?redirect=" + encodeURIComponent(next)}
							>
								<Code2 size={17} />
								GitHub
							</a>
						</>
					) : null}
					<p className="hint">
						Setting up for the first time?{" "}
						<Link className="link" href="/setup">
							Read the deployment guide.
						</Link>
					</p>
					<div className="auth-note">
						<ShieldCheck size={17} />
						<span className="hint">
							Console sessions are separate from API keys. Your password is
							never used to authenticate model requests.
						</span>
					</div>
				</form>
			</main>
		</div>
	)
}
