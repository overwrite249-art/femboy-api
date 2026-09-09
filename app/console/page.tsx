"use client"
import Link from "next/link"
import { Activity, ArrowUpRight, Play, ShieldCheck } from "lucide-react"
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
					eyebrow="Console"
					title="Your access"
					description="Send requests with a gateway key issued to your account. The reference documents the supported endpoints."
				/>
				<div className="quick-actions">
					<Link href="/console/playground" className="quick-action">
						<strong>Playground</strong>
						<span>Send a request to a configured model</span>
						<ArrowUpRight size={16} />
					</Link>
					<Link href="/console/docs" className="quick-action">
						<strong>API reference</strong>
						<span>Endpoints, parameters and examples</span>
						<ArrowUpRight size={16} />
					</Link>
				</div>
				<Quickstart />
			</>
		)
	return (
		<>
			<PageHeader
				eyebrow="Console"
				title="Overview"
				description="Recorded usage for the current UTC month, plus the configuration of this deployment."
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
							/>
							<StatCard
								label="Total spend"
								value={formatUsd(data.summary.usd)}
								sub={`${formatNumber(data.summary.quota)} quota units`}
							/>
							<StatCard
								label="Tokens processed"
								value={formatNumber(
									data.summary.promptTokens + data.summary.completionTokens,
								)}
								sub={`${formatNumber(data.summary.promptTokens)} input · ${formatNumber(data.summary.completionTokens)} output`}
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
							/>
						</div>
					</div>
					<div className="section">
						<div className="section-head">
							<h2 className="section-title">Configuration</h2>
							<Link
								className="subtle-link"
								href={
									user?.role === "root" ? "/console/setup" : "/console/docs"
								}
							>
								Deployment guidance <ArrowUpRight size={15} />
							</Link>
						</div>
						<dl className="state-list">
							{[
								{
									label: "Provider channels",
									ready: data.inventory.channels > 0,
									detail: data.inventory.channels
										? `${data.inventory.enabledChannels} enabled of ${data.inventory.channels}`
										: "None configured",
									href: "/console/channels",
								},
								{
									label: "Gateway keys",
									ready: data.inventory.tokens > 0,
									detail: data.inventory.tokens
										? `${formatNumber(data.inventory.tokens)} issued`
										: "None issued",
									href: "/console/tokens",
								},
								{
									label: "People & balances",
									ready: data.inventory.users > 0,
									detail: `${formatNumber(data.inventory.users)} users`,
									href: "/console/users",
								},
								{
									label: "Recorded requests",
									ready: data.summary.requests > 0,
									detail: data.summary.requests
										? `${formatNumber(data.summary.requests)} this month`
										: "A funded user balance is required",
									href: "/console/playground",
								},
							].map((row) => (
								<div key={row.label}>
									<dt>
										<Link className="link" href={row.href}>
											{row.label}
										</Link>
									</dt>
									<dd>
										<span className="state-flag">
											{row.ready ? "ready" : "pending"}
										</span>
										{row.detail}
									</dd>
								</div>
							))}
						</dl>
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
									<h3>No usage recorded yet</h3>
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
							<h2 className="section-title">Request example</h2>
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
