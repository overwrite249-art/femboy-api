"use client"

import {
	Bar,
	Callout,
	ErrorNote,
	Loading,
	Panel,
	StatCard,
	formatNumber,
	formatPercent,
	formatUsd,
	quotaToUsd,
	useApi,
} from "./ui.tsx"

type TopModel = { model: string; requests: number; quota: number }

type Overview = {
	summary: {
		bucketPrefix: string
		requests: number
		errors: number
		quota: number
		usd: number
		promptTokens: number
		completionTokens: number
		topModels: TopModel[]
	}
	siteName: string
	quotaPerUnit: number
	month: string
}

export default function OverviewPage() {
	const overview = useApi<Overview>("/api/admin/overview")

	if (overview.loading && !overview.data) return <Loading rows={4} />
	if (overview.error) return <ErrorNote message={overview.error} />
	if (!overview.data) return null

	const summary = overview.data.summary
	const perUnit = overview.data.quotaPerUnit
	const tokens = summary.promptTokens + summary.completionTokens
	const topQuota = summary.topModels.reduce(
		(most, entry) => Math.max(most, entry.quota),
		0,
	)

	return (
		<>
			<section className="section">
				<div className="cards">
					<StatCard
						label="Requests"
						value={formatNumber(summary.requests)}
						sub={overview.data.month}
					/>
					<StatCard
						label="Spend"
						value={formatUsd(summary.usd)}
						sub={formatNumber(summary.quota) + " quota units"}
					/>
					<StatCard
						label="Error rate"
						value={formatPercent(summary.errors, summary.requests)}
						sub={formatNumber(summary.errors) + " failed"}
					/>
					<StatCard
						label="Tokens"
						value={formatNumber(tokens)}
						sub={
							formatNumber(summary.promptTokens) +
							" in / " +
							formatNumber(summary.completionTokens) +
							" out"
						}
					/>
				</div>
			</section>

			{summary.requests === 0 ? (
				<section className="section">
					<Callout tone="warn">
						No requests have been recorded this month. Add a channel, mint a token,
						and point a client at <span className="mono">/v1/chat/completions</span>.
					</Callout>
				</section>
			) : null}

			<section className="section">
				<Panel title="Spend by model" note={"bucket " + summary.bucketPrefix}>
					{summary.topModels.length === 0 ? (
						<div className="empty">Nothing billed yet.</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>Model</th>
									<th className="num">Requests</th>
									<th className="num hide-sm">Quota</th>
									<th className="num">USD</th>
									<th className="hide-sm">Share</th>
								</tr>
							</thead>
							<tbody>
								{summary.topModels.map((entry) => (
									<tr key={entry.model}>
										<td className="mono">{entry.model}</td>
										<td className="num">{formatNumber(entry.requests)}</td>
										<td className="num hide-sm">{formatNumber(entry.quota)}</td>
										<td className="num">{formatUsd(quotaToUsd(entry.quota, perUnit))}</td>
										<td className="hide-sm">
											<Bar value={entry.quota} total={topQuota} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</section>

			<section className="section">
				<Panel title="Deployment">
					<table>
						<tbody>
							<tr>
								<td className="muted">Site name</td>
								<td>{overview.data.siteName}</td>
							</tr>
							<tr>
								<td className="muted">Quota units per USD</td>
								<td className="num">{formatNumber(perUnit)}</td>
							</tr>
							<tr>
								<td className="muted">Current bucket</td>
								<td className="mono">{summary.bucketPrefix}</td>
							</tr>
						</tbody>
					</table>
				</Panel>
			</section>

			<p className="hint">
				Prompt and completion content is never stored, so this page can report
				shape and cost but never what was asked.
			</p>
		</>
	)
}
