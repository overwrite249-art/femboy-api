"use client"

import {
	ErrorNote,
	Loading,
	Panel,
	Pill,
	StatCard,
	formatDate,
	formatNumber,
	formatPercent,
	formatUsd,
	httpTone,
	useApi,
} from "../ui.tsx"

type Summary = {
	bucketPrefix: string
	requests: number
	errors: number
	quota: number
	usd: number
	promptTokens: number
	completionTokens: number
	topModels: Array<{ model: string; requests: number; quota: number }>
}

type UsageRow = {
	_id?: string
	requestId?: string
	model?: string
	billedModel?: string
	channelId?: string
	endpoint?: string
	stream?: boolean
	promptTokens?: number
	completionTokens?: number
	quota?: number
	elapsedMs?: number
	httpStatus?: number
	status?: string
	createdAt?: string
}

type UsageList = { usage?: UsageRow[]; rows?: UsageRow[]; logs?: UsageRow[] }

export default function UsagePage() {
	const summary = useApi<{ summary: Summary }>("/api/admin/usage/summary")
	const recent = useApi<UsageList>("/api/admin/usage?limit=50")

	const data = summary.data?.summary
	const rows = recent.data?.usage ?? recent.data?.rows ?? recent.data?.logs ?? []

	return (
		<>
			<ErrorNote message={summary.error || recent.error} />

			{data ? (
				<section className="section">
					<div className="cards">
						<StatCard label="Requests" value={formatNumber(data.requests)} sub={data.bucketPrefix} />
						<StatCard
							label="Spend"
							value={formatUsd(data.usd)}
							sub={formatNumber(data.quota) + " quota"}
						/>
						<StatCard
							label="Errors"
							value={formatNumber(data.errors)}
							sub={formatPercent(data.errors, data.requests)}
						/>
						<StatCard
							label="Tokens"
							value={formatNumber(data.promptTokens + data.completionTokens)}
							sub={formatNumber(data.promptTokens) + " in"}
						/>
					</div>
				</section>
			) : null}

			<section className="section">
				<Panel title="Recent requests" note="content is never stored">
					{recent.loading && rows.length === 0 ? (
						<Loading />
					) : rows.length === 0 ? (
						<div className="empty">Nothing recorded yet.</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>When</th>
									<th>Model</th>
									<th className="hide-sm">Endpoint</th>
									<th className="num">Tokens</th>
									<th className="num hide-sm">Quota</th>
									<th className="num hide-sm">Latency</th>
									<th>Status</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row, index) => (
									<tr key={row.requestId ?? row._id ?? String(index)}>
										<td className="hint">{formatDate(row.createdAt)}</td>
										<td className="mono">{row.model ?? "\u2014"}</td>
										<td className="mono hide-sm hint">{row.endpoint ?? "\u2014"}</td>
										<td className="num">
											{formatNumber((row.promptTokens ?? 0) + (row.completionTokens ?? 0))}
										</td>
										<td className="num hide-sm">{formatNumber(row.quota ?? 0)}</td>
										<td className="num hide-sm">
											{row.elapsedMs ? (row.elapsedMs / 1000).toFixed(2) + "s" : "\u2014"}
										</td>
										<td>
											<Pill tone={httpTone(row.httpStatus)}>
												{formatNumber(row.httpStatus ?? 0)}
											</Pill>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</section>
		</>
	)
}
