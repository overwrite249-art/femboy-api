"use client"

import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { useRouter, useSearchParams } from "next/navigation"

function localPath(value: string | null): string {
	// The same rule the server applies: a return path is a local path or it is
	// nothing. Accepting "//host" here would hand out an open redirect.
	if (!value) return "/console"
	if (!value.startsWith("/")) return "/console"
	if (value.startsWith("//")) return "/console"
	return value
}

export default function LoginPage() {
	const router = useRouter()
	const params = useSearchParams()
	const next = localPath(params.get("redirect"))

	const [username, setUsername] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [checking, setChecking] = useState(true)

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
		setBusy(true)
		setError("")
		try {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
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
			<form className="auth-card" onSubmit={submit}>
				<div className="brand">
					<div className="brand-mark" />
					<div>
						<div className="brand-name">femboy api</div>
						<div className="brand-sub">console sign-in</div>
					</div>
				</div>

				<h1 className="auth-title">Sign in</h1>

				{error ? <div className="auth-error">{error}</div> : null}

				<div className="field">
					<label htmlFor="username">Username</label>
					<input
						id="username"
						name="username"
						autoComplete="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						required
					/>
				</div>

				<div className="field">
					<label htmlFor="password">Password</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
					/>
				</div>

				<button className="btn btn-primary" type="submit" disabled={busy || checking}>
					{busy ? "Signing in" : "Sign in"}
				</button>

				<div className="auth-divider">or</div>

				<a className="btn" href={"/api/auth/github?redirect=" + encodeURIComponent(next)}>
					Continue with GitHub
				</a>

				<p className="hint">
					Signing in creates a console session. It cannot be used as an API key, and
					an API key cannot be used to sign in here.
				</p>
			</form>
		</main>
	)
}
