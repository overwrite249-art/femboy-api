"use client"

import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"

import { loadSession, signOut } from "./api.ts"
import type { ConsoleUser } from "./api.ts"

type NavEntry = { href: string; label: string; group: string }

const NAV: NavEntry[] = [
	{ href: "/console", label: "Overview", group: "Operate" },
	{ href: "/console/channels", label: "Channels", group: "Operate" },
	{ href: "/console/usage", label: "Usage", group: "Operate" },
	{ href: "/console/audit", label: "Audit log", group: "Operate" },
	{ href: "/console/tokens", label: "Tokens", group: "Access" },
	{ href: "/console/users", label: "Users", group: "Access" },
	{ href: "/console/redemption", label: "Redemption", group: "Access" },
	{ href: "/console/pricing", label: "Pricing", group: "Billing" },
	{ href: "/console/settings", label: "Settings", group: "Billing" },
]

const GROUPS = ["Operate", "Access", "Billing"]

function titleFor(pathname: string): string {
	let best = "Console"
	let bestLength = -1
	for (const entry of NAV) {
		if (pathname === entry.href || pathname.startsWith(entry.href + "/")) {
			if (entry.href.length > bestLength) {
				best = entry.label
				bestLength = entry.href.length
			}
		}
	}
	return best
}

function isActive(pathname: string, href: string): boolean {
	if (href === "/console") return pathname === "/console"
	return pathname === href || pathname.startsWith(href + "/")
}

export default function ConsoleLayout(props: { children: ReactNode }) {
	const pathname = usePathname() ?? "/console"
	const router = useRouter()
	const [user, setUser] = useState<ConsoleUser | null>(null)
	const [checked, setChecked] = useState(false)

	useEffect(() => {
		let cancelled = false
		loadSession().then((value) => {
			if (cancelled) return
			setUser(value)
			setChecked(true)
			if (!value) {
				router.replace("/login?redirect=" + encodeURIComponent(pathname))
			}
		})
		return () => {
			cancelled = true
		}
	}, [router, pathname])

	async function leave() {
		await signOut()
		router.replace("/login")
	}

	const initial = (user?.username ?? "?").slice(0, 1)

	return (
		<div className="shell">
			<aside className="sidebar">
				<div className="brand">
					<div className="brand-mark" />
					<div>
						<div className="brand-name">femboy api</div>
						<div className="brand-sub">console</div>
					</div>
				</div>

				<nav className="nav">
					{GROUPS.map((group) => (
						<div key={group}>
							<div className="nav-label">{group}</div>
							{NAV.filter((entry) => entry.group === group).map((entry) => (
								<Link
									key={entry.href}
									href={entry.href}
									className={
										isActive(pathname, entry.href) ? "nav-item active" : "nav-item"
									}
								>
									<span className="nav-dot" />
									{entry.label}
								</Link>
							))}
						</div>
					))}
				</nav>

				<div className="sidebar-foot">
					<div className="who">
						<div className="avatar">{initial}</div>
						<div>
							<div className="who-name">{user?.username ?? "signing in"}</div>
							<div className="who-role">{user?.role ?? "\u2014"}</div>
						</div>
					</div>
				</div>
			</aside>

			<main className="main">
				<div className="railbar">
					{NAV.map((entry) => (
						<Link
							key={entry.href}
							href={entry.href}
							className={
								isActive(pathname, entry.href) ? "rail-item active" : "rail-item"
							}
						>
							{entry.label}
						</Link>
					))}
				</div>

				<header className="topbar">
					<div>
						<div className="crumbs">Console</div>
						<h1 className="title">{titleFor(pathname)}</h1>
					</div>
					<div className="topbar-actions">
						<button className="btn btn-small" type="button" onClick={leave}>
							Sign out
						</button>
					</div>
				</header>

				<div className="content">
					{checked && !user ? (
						<div className="empty">Redirecting to sign-in.</div>
					) : (
						props.children
					)}
				</div>
			</main>
		</div>
	)
}
