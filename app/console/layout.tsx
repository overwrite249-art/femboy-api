"use client"

import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
	Activity,
	ArrowRight,
	BookOpen,
	Boxes,
	ChevronRight,
	Command,
	Gift,
	KeyRound,
	LayoutDashboard,
	LogOut,
	Menu,
	PanelLeftClose,
	PanelLeftOpen,
	Play,
	Search,
	Settings2,
	ShieldCheck,
	SlidersHorizontal,
	UsersRound,
	Wallet,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Brand, Dialog, ThemePicker } from "../components/interface.tsx"
import { loadSession, signOut } from "./api.ts"
import type { ConsoleUser } from "./api.ts"
import { SessionContext } from "./session-context.tsx"
import { matchesSearch } from "../../lib/console/client-utils.ts"

type NavEntry = {
	href: string
	label: string
	group: string
	icon: LucideIcon
	description: string
	member?: boolean
	root?: boolean
}
const NAV: NavEntry[] = [
	{
		href: "/console",
		label: "Overview",
		group: "Workspace",
		icon: LayoutDashboard,
		description: "Your gateway at a glance",
		member: true,
	},
	{
		href: "/console/playground",
		label: "Playground",
		group: "Workspace",
		icon: Play,
		description: "Try a chat completion request",
		member: true,
	},
	{
		href: "/console/channels",
		label: "Channels",
		group: "Workspace",
		icon: Boxes,
		description: "Connect and manage model providers",
	},
	{
		href: "/console/usage",
		label: "Usage & logs",
		group: "Workspace",
		icon: Activity,
		description: "Inspect requests, tokens, and spend",
	},
	{
		href: "/console/tokens",
		label: "API keys",
		group: "Manage",
		icon: KeyRound,
		description: "Issue and rotate scoped gateway tokens",
	},
	{
		href: "/console/users",
		label: "Users",
		group: "Manage",
		icon: UsersRound,
		description: "Manage roles and quota balances",
	},
	{
		href: "/console/pricing",
		label: "Pricing",
		group: "Manage",
		icon: Wallet,
		description: "Pricing overrides and model aliases",
	},
	{
		href: "/console/redemption",
		label: "Redemption",
		group: "Manage",
		icon: Gift,
		description: "Generate single-use credit codes",
	},
	{
		href: "/console/audit",
		label: "Audit trail",
		group: "System",
		icon: ShieldCheck,
		description: "Review administrative changes",
	},
	{
		href: "/console/setup",
		label: "Deployment",
		group: "System",
		icon: SlidersHorizontal,
		description: "Configure scheduled maintenance",
		root: true,
	},
	{
		href: "/console/settings",
		label: "Settings",
		group: "System",
		icon: Settings2,
		description: "Preferences and stored configuration",
	},
	{
		href: "/console/docs",
		label: "API reference",
		group: "System",
		icon: BookOpen,
		description: "Integration examples and endpoint reference",
		member: true,
	},
]
function active(path: string, href: string) {
	return href === "/console"
		? path === href
		: path === href || path.startsWith(href + "/")
}

export default function ConsoleLayout({ children }: { children: ReactNode }) {
	const pathname = usePathname() ?? "/console"
	const router = useRouter()
	const [user, setUser] = useState<ConsoleUser | null>(null)
	const [checked, setChecked] = useState(false)
	const [logoutError, setLogoutError] = useState("")
	const [leaving, setLeaving] = useState(false)
	const [compact, setCompact] = useState(false)
	const [mobile, setMobile] = useState(false)
	const [palette, setPalette] = useState(false)
	const [query, setQuery] = useState("")
	const [selected, setSelected] = useState(0)
	const searchRef = useRef<HTMLInputElement>(null)
	useEffect(() => {
		let cancelled = false
		setMobile(false)
		setPalette(false)
		loadSession().then((value) => {
			if (cancelled) return
			setUser(value)
			setChecked(true)
			if (!value)
				router.replace("/login?redirect=" + encodeURIComponent(pathname))
		})
		return () => {
			cancelled = true
		}
	}, [router, pathname])
	useEffect(() => {
		try {
			setCompact(localStorage.getItem("femboy-ui-sidebar") === "compact")
		} catch {
			/* optional */
		}
		const keyboard = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault()
				setQuery("")
				setSelected(0)
				setPalette((value) => !value)
			}
		}
		window.addEventListener("keydown", keyboard)
		return () => window.removeEventListener("keydown", keyboard)
	}, [])
	useEffect(() => {
		if (palette) searchRef.current?.focus()
	}, [palette])
	const admin = user?.role === "root" || user?.role === "admin"
	const nav = NAV.filter(
		(entry) =>
			(admin || entry.member) && (!entry.root || user?.role === "root"),
	)
	const current = NAV.find((entry) => active(pathname, entry.href))
	const allowed = !current || nav.includes(current)
	const results = nav.filter((entry) =>
		matchesSearch(query, entry.label, entry.description, entry.group),
	)
	useEffect(() => {
		if (palette)
			document
				.getElementById("command-item-" + selected)
				?.scrollIntoView({ block: "nearest" })
	}, [palette, selected])
	function toggleCompact() {
		setCompact(!compact)
		try {
			localStorage.setItem(
				"femboy-ui-sidebar",
				compact ? "expanded" : "compact",
			)
		} catch {
			/* optional */
		}
	}
	async function leave() {
		if (leaving) return
		setLeaving(true)
		setLogoutError("")
		try {
			await signOut()
			setUser(null)
			router.replace("/login")
		} catch {
			setLogoutError(
				"Sign-out failed. Your session may still be active; please retry.",
			)
		} finally {
			setLeaving(false)
		}
	}
	function navigation() {
		return (
			<>
				<Link
					href="/console"
					className="sidebar-brand"
					aria-label="femboy api home"
				>
					<Brand compact={compact && !mobile} />
				</Link>
				<div className="workspace-switch">
					<span className="workspace-icon">F</span>
					<span className="nav-copy">
						<strong>My gateway</strong>
						<small>Personal workspace</small>
					</span>
					<span className="workspace-badge nav-copy">SELF-HOSTED</span>
				</div>
				<nav className="nav" aria-label="Main navigation">
					{["Workspace", "Manage", "System"].map((group) =>
						nav.some((entry) => entry.group === group) ? (
							<div className="nav-group" key={group}>
								<div className="nav-label">{group}</div>
								{nav
									.filter((entry) => entry.group === group)
									.map(({ href, label, icon: Icon }) => (
										<Link
											key={href}
											href={href}
											className={
												active(pathname, href) ? "nav-item active" : "nav-item"
											}
											title={compact ? label : undefined}
											aria-current={active(pathname, href) ? "page" : undefined}
										>
											<Icon size={19} />
											<span className="nav-copy">{label}</span>
										</Link>
									))}
							</div>
						) : null,
					)}
				</nav>
				<div className="sidebar-foot">
					<Link href="/console/docs" className="sidebar-help">
						<BookOpen size={18} />
						<span className="nav-copy">
							API reference
							<small>
								Endpoints and examples <ArrowRight size={13} />
							</small>
						</span>
					</Link>
					<div className="who">
						<span className="avatar">
							{(user?.username ?? "?").slice(0, 1).toUpperCase()}
						</span>
						<span className="nav-copy">
							<span className="who-name">
								{user?.displayName || user?.username || "Signing in…"}
							</span>
							<span className="who-role">
								{user?.role ?? "Checking session"}
							</span>
						</span>
						<button
							className="icon-btn nav-copy"
							type="button"
							onClick={leave}
							disabled={leaving}
							aria-label="Sign out"
							title="Sign out"
						>
							<LogOut size={18} />
						</button>
					</div>
				</div>
			</>
		)
	}
	return (
		<SessionContext.Provider value={user}>
			<div className={"shell" + (compact ? " shell-compact" : "")}>
				<a className="skip-link" href="#main-content">
					Skip to content
				</a>
				<aside className="sidebar">{navigation()}</aside>
				<Dialog
					open={mobile}
					title="Navigation"
					onClose={() => setMobile(false)}
					className="mobile-navigation"
				>
					<div className="mobile-sidebar">{navigation()}</div>
				</Dialog>
				<div className="main">
					<header className="topbar">
						<div className="topbar-left">
							<button
								type="button"
								className="icon-btn desktop-only"
								onClick={toggleCompact}
								aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
							>
								{compact ? (
									<PanelLeftOpen size={19} />
								) : (
									<PanelLeftClose size={19} />
								)}
							</button>
							<button
								type="button"
								className="icon-btn mobile-only"
								onClick={() => setMobile(true)}
								aria-label="Open navigation"
							>
								<Menu size={21} />
							</button>
							<div className="breadcrumbs">
								<span>Workspace</span>
								<ChevronRight size={14} />
								<strong>{current?.label ?? "Console"}</strong>
							</div>
						</div>
						<div className="topbar-actions">
							<button
								type="button"
								className="command-trigger"
								onClick={() => {
									setQuery("")
									setSelected(0)
									setPalette(true)
								}}
								aria-label="Search console"
							>
								<Search size={17} />
								<span>Quick search…</span>
								<kbd>⌘ K</kbd>
							</button>
							<ThemePicker />
							<Link
								href="/console/docs"
								className="icon-btn help-button"
								aria-label="API reference"
							>
								<BookOpen size={19} />
							</Link>
						</div>
					</header>
					<main id="main-content" className="content" tabIndex={-1}>
						{logoutError ? (
							<p role="alert" className="auth-error">
								{logoutError}
							</p>
						) : null}
						{!checked ? (
							<div className="session-loading" role="status">
								<span className="loader" />
								Opening your workspace…
							</div>
						) : !user ? (
							<div className="empty">Redirecting to sign-in…</div>
						) : !allowed ? (
							<div className="restricted-state">
								<ShieldCheck size={40} />
								<h1>This area needs elevated access</h1>
								<p>
									Your session is signed in as {user.role}. Ask a root
									administrator if you need access.
								</p>
								<Link className="btn btn-primary" href="/console">
									Back to overview
								</Link>
							</div>
						) : (
							children
						)}
						<footer className="console-footer">
							<span>
								<LayersMark />
								femboy / api
							</span>
							<Link href="/console/docs">
								Developer reference <ArrowRight size={13} />
							</Link>
						</footer>
					</main>
				</div>
				<Dialog
					open={palette}
					title="Jump to anything"
					onClose={() => setPalette(false)}
					className="command-dialog"
				>
					<div className="command-search">
						<Search size={21} />
						<input
							ref={searchRef}
							aria-label="Search pages and actions"
							placeholder="Search pages and actions…"
							value={query}
							onChange={(event) => {
								setQuery(event.target.value)
								setSelected(0)
							}}
							onKeyDown={(event) => {
								if (event.key === "ArrowDown") {
									event.preventDefault()
									setSelected((value) =>
										Math.min(value + 1, results.length - 1),
									)
								}
								if (event.key === "ArrowUp") {
									event.preventDefault()
									setSelected((value) => Math.max(0, value - 1))
								}
								if (event.key === "Enter" && results[selected]) {
									event.preventDefault()
									setPalette(false)
									router.push(results[selected].href)
								}
							}}
						/>
					</div>
					<div className="command-results">
						{results.length ? (
							results.map((entry, index) => (
								<button
									id={"command-item-" + index}
									key={entry.href}
									type="button"
									className={
										selected === index
											? "command-result selected"
											: "command-result"
									}
									onFocus={() => setSelected(index)}
									onClick={() => {
										setPalette(false)
										router.push(entry.href)
									}}
								>
									<entry.icon size={20} />
									<span>
										<strong>{entry.label}</strong>
										<small>{entry.description}</small>
									</span>
									<ArrowRight size={16} />
								</button>
							))
						) : (
							<div className="empty">
								No matching pages. Try “keys”, “usage”, or “deployment”.
							</div>
						)}
					</div>
					<div className="command-foot">
						<span>↑ ↓ to browse · Enter to open</span>
						<span>Esc to close</span>
					</div>
				</Dialog>
			</div>
		</SessionContext.Provider>
	)
}
function LayersMark() {
	return <Command size={13} />
}
