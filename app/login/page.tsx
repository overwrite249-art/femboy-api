import { Suspense } from "react"
import { config } from "../../lib/config/env.ts"
import LoginForm from "./form.tsx"
export const dynamic = "force-dynamic"
export const metadata = { title: "Sign in · femboy api" }
export default function LoginPage() {
	const githubEnabled = Boolean(
		config.githubClientId && config.githubClientSecret,
	)
	return (
		<Suspense
			fallback={
				<main className="auth">
					<p role="status">Loading sign-in…</p>
				</main>
			}
		>
			<LoginForm githubEnabled={githubEnabled} />
		</Suspense>
	)
}
