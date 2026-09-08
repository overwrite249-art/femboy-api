"use client"
import Link from "next/link"
import {
	Activity,
	ArrowRight,
	ArrowUpRight,
	BookOpen,
	Boxes,
	Check,
	Code2,
	Coins,
	KeyRound,
	Play,
	Plus,
	ShieldCheck,
	Sparkles,
	UsersRound,
	Zap,
} from "lucide-react"
import { CopyButton } from "../components/interface.tsx"
import { useSession } from "./session-context.tsx"
import { Quickstart, useOrigin } from "./quickstart.tsx"
import {
	Empty,
	ErrorNote,
	Loading,
	PageHeader,
	Panel,
	Pill,
	RefreshButton,
	StatCard,
	formatNumber,
	formatPercent,
	formatUsd,
	quotaToUsd,
	useApi,
} from "./ui.tsx"

type Overview = {
	summary: {
		bucketPrefix: string
		requests: number
		errors: number
		quota: number
		usd: number
		promptTokens: number
		completionTokens: number
		topModels: { model: string; requests: number; quota: number }[]
	}
	siteName: string
	quotaPerUnit: number
	month: string
	inventory: {
		channels: number
		enabledChannels: number
		tokens: number
		users: number
	}
	coordination: string
}
export default function OverviewPage() {
	const user = useSession()
	const admin = user?.role === "root" || user?.role === "admin"
	const overview = useApi<Overview>(admin ? "/api/admin/overview" : null)
	const origin = useOrigin()
	const data = overview.data
	if (!admin)
		return (
			<>
				<PageHeader
					eyebrow="YOUR WORKSPACE"
					title={`Welcome, ${user?.displayName || user?.username || "there"}`}
					description="One endpoint for your AI workflow. Explore the reference or try a request with your gateway key."
				/>
				<div className="quick-actions">
					<Link href="/console/playground" className="quick-action">
						<Play />
						<strong>Open playground</strong>
						<span>Try your configured models</span>
						<ArrowUpRight />
					</Link>
					<Link href="/console/docs" className="quick-action">
						<BookOpen />
						<strong>Start building</strong>
						<span>Integrate with your favorite SDK</span>
						<ArrowUpRight />
					</Link>
				</div>
				<Quickstart />
			</>
		)
	return (
		<>
			<PageHeader
				eyebrow="WORKSPACE OVERVIEW"
				title={`Welcome back, ${user?.displayName || user?.username || "there"}`}
				description="A little less infrastructure. A lot more possibility."
				actions={
					<>
						<RefreshButton
							onClick={overview.reload}
							loading={overview.loading}
						/>
						<Link href="/console/playground" className="btn btn-primary">
							<Play size={16} />
							Open playground
						</Link>
					</>
				}
			/>
			<ErrorNote message={overview.error} />
			{overview.loading && !data ? (
				<Loading rows={4} />
			) : data ? (
				<>
					<div className="section">
						<div className="section-head">
							<span className="section-kicker">
								<Activity size={16} />
								Gateway activity
							</span>
							<span className="section-note">
								{data.month.slice(0, 4)} / {data.month.slice(4)} · UTC month
							</span>
							<Pill tone="info">Recorded usage</Pill>
						</div>
						<div className="cards">
							<StatCard
								label="Total requests"
								value={formatNumber(data.summary.requests)}
								sub="Requests this month"
								icon={<Activity size={18} />}
							/>
							<StatCard
								label="Total spend"
								value={formatUsd(data.summary.usd)}
								sub={`${formatNumber(data.summary.quota)} quota units`}
								icon={<Coins size={18} />}
							/>
							<StatCard
								label="Tokens processed"
								value={formatNumber(
									data.summary.promptTokens + data.summary.completionTokens,
								)}
								sub={`${formatNumber(data.summary.promptTokens)} input · ${formatNumber(data.summary.completionTokens)} output`}
								icon={<Zap size={18} />}
							/>
							<StatCard
								label="Error rate"
								value={formatPercent(
									data.summary.errors,
									data.summary.requests,
								)}
								sub={
									data.summary.requests
										? `${formatNumber(data.summary.errors)} failed requests`
										: "No traffic recorded yet"
								}
								icon={<ShieldCheck size={18} />}
							/>
						</div>
					</div>
					<div className="overview-grid section">
						<section className="launch-card">
							<div className="launch-badge">
								<Sparkles size={15} />
								{data.inventory.channels
									? "BUILD WITH YOUR GATEWAY"
									: "LET’S GET YOU CONNECTED"}
							</div>
							<h2>
								{data.inventory.channels
									? "Your next idea starts here."
									: "One gateway.\nEndless possibilities."}
							</h2>
							<p>
								{data.inventory.channels
									? "Your provider connections are in place. Explore a model, scope an API key, and start building."
									: "Connect a provider, create your first API key, and bring your favorite models into one workspace."}
							</p>
							<div className="launch-actions">
								<Link
									className="btn btn-white"
									href={
										data.inventory.channels
											? "/console/playground"
											: "/console/channels#create"
									}
								>
									{data.inventory.channels ? (
										<Play size={16} />
									) : (
										<Plus size={16} />
									)}
									{data.inventory.channels
										? "Try a request"
										: "Connect a provider"}
									<ArrowRight size={16} />
								</Link>
								<Link className="launch-link" href="/console/docs">
									Read the guide <ArrowUpRight size={15} />
								</Link>
							</div>
							<div className="provider-strip">
								<span>OpenAI</span>
								<span>Anthropic</span>
								<span>Gemini</span>
								<span>+ compatible APIs</span>
							</div>
						</section>
						<Panel title="Your launch checklist" note="Configuration">
							<div className="checklist">
								{[
									{
										done: data.inventory.channels > 0,
										title: "Connect a provider",
										sub: `${data.inventory.enabledChannels} enabled · ${data.inventory.channels} total channels`,
										href: "/console/channels",
										icon: Boxes,
									},
									{
										done: data.inventory.tokens > 0,
										title: "Create a gateway key",
										sub: "Scoped access for your applications",
										href: "/console/tokens",
										icon: KeyRound,
									},
									{
										done: data.summary.requests > 0,
										title: "Send your first request",
										sub: "A funded user balance is required",
										href: "/console/playground",
										icon: Code2,
									},
								].map((step, index) => (
									<Link
										className="checklist-item"
										href={step.href}
										key={step.href}
									>
										<span
											className={step.done ? "step-number done" : "step-number"}
										>
											{step.done ? <Check size={16} /> : index + 1}
										</span>
										<span>
											<strong>{step.title}</strong>
											<small>{step.sub}</small>
										</span>
										<ArrowRight size={16} />
									</Link>
								))}
							</div>
							<Link
								className="subtle-link"
								href={
									user?.role === "root" ? "/console/setup" : "/console/docs"
								}
							>
								View deployment guidance <ArrowUpRight size={15} />
							</Link>
						</Panel>
					</div>
					<div className="quick-actions section">
						{[
							{
								href: "/console/channels",
								icon: Boxes,
								title: "Provider channels",
								sub: `${data.inventory.channels} connected channels`,
							},
							{
								href: "/console/tokens",
								icon: KeyRound,
								title: "Gateway keys",
								sub: `${data.inventory.tokens} issued tokens`,
							},
							{
								href: "/console/users",
								icon: UsersRound,
								title: "People & balances",
								sub: `${data.inventory.users} workspace users`,
							},
						].map((action) => (
							<Link
								className="quick-action"
								key={action.href}
								href={action.href}
							>
								<action.icon size={21} />
								<strong>{action.title}</strong>
								<span>{action.sub}</span>
								<ArrowUpRight size={18} />
							</Link>
						))}
					</div>
					<div className="overview-grid section">
						<Panel
							title="Model activity"
							note="Top 10 by spend"
							actions={
								<Link className="subtle-link" href="/console/usage">
									View usage <ArrowUpRight size={15} />
								</Link>
							}
						>
							{data.summary.topModels.length ? (
								<table>
									<thead>
										<tr>
											<th>Model</th>
											<th className="num">Requests</th>
											<th className="num">Spend</th>
										</tr>
									</thead>
									<tbody>
										{data.summary.topModels.map((model) => (
											<tr key={model.model}>
												<td className="mono">{model.model}</td>
												<td className="num">{formatNumber(model.requests)}</td>
												<td className="num">
													{formatUsd(
														quotaToUsd(model.quota, data.quotaPerUnit),
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							) : (
								<Empty>
									<h3>Your next request belongs here</h3>
									<p>
										Usage appears after requests are recorded and rolled up. We
										never fill this view with sample traffic.
									</p>
									<Link className="btn btn-small" href="/console/playground">
										<Play size={15} />
										Explore playground
									</Link>
								</Empty>
							)}
						</Panel>
						<Panel title="Connection details" note="Your gateway">
							<div className="endpoint-box">
								<label>OpenAI-compatible base URL</label>
								<div>
									<code>{origin}/v1</code>
									<CopyButton
										value={origin + "/v1"}
										label="Copy base URL"
										iconOnly
									/>
								</div>
							</div>
							<dl className="detail-list">
								<div>
									<dt>Workspace</dt>
									<dd>{data.siteName}</dd>
								</div>
								<div>
									<dt>Coordination</dt>
									<dd>
										{data.coordination === "mongo"
											? "MongoDB"
											: data.coordination}
									</dd>
								</div>
								<div>
									<dt>Quota units / USD</dt>
									<dd>{formatNumber(data.quotaPerUnit)}</dd>
								</div>
							</dl>
							<p className="privacy-note">
								<ShieldCheck size={16} />
								Prompt and completion content is not stored in usage logs.
							</p>
						</Panel>
					</div>
					<div className="section">
						<div className="section-head">
							<h2 className="section-title">From idea to API call</h2>
							<Link className="subtle-link" href="/console/docs">
								API reference <ArrowUpRight size={15} />
							</Link>
						</div>
						<Quickstart />
					</div>
				</>
			) : null}
		</>
	)
}
