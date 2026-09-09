"use client"

import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, Eye, EyeOff, Code2 } from "lucide-react"
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
		<main className="auth">
			<div className="auth-tools">
				<Link className="subtle-link" href="/">
					<ArrowLeft size={16} />
					Back to home
				</Link>
				<ThemePicker />
			</div>
			<div className="auth-panel">
				<Link className="auth-brand" href="/">
					<Brand />
				</Link>
				<form className="auth-card" onSubmit={submit}>
					<div className="auth-head">
						<span className="auth-kicker">Console access</span>
						<h1 className="auth-title">Sign in</h1>
						<p>
							The console manages provider channels, gateway keys, balances and
							usage for this deployment.
						</p>
					</div>
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
						{busy ? "Signing in…" : checking ? "Checking session…" : "Sign in"}
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
				</form>
				<dl className="auth-facts">
					<div>
						<dt>Session</dt>
						<dd>
							Console sessions are separate from API keys. This password never
							authenticates model requests.
						</dd>
					</div>
					<div>
						<dt>First run</dt>
						<dd>
							The first administrator is created out of band. See the{" "}
							<Link className="link" href="/setup">
								deployment guide
							</Link>
							.
						</dd>
					</div>
				</dl>
			</div>
		</main>
	)
}
