"use client"
import { useState } from "react"
import {
	Activity,
	AlertTriangle,
	Coins,
	Download,
	Eye,
	Zap,
} from "lucide-react"
import { CopyButton, Dialog } from "../../components/interface.tsx"
import {
	downloadCsv,
	matchesSearch,
	monthBucket,
	utcMonth,
} from "../../../lib/console/client-utils.ts"
import {
	Empty,
	ErrorNote,
	Loading,
	PageHeader,
	Pagination,
	Panel,
	Pill,
	RefreshButton,
	SearchInput,
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
}
type UsageRow = {
	_id?: string
	requestId?: string
	model?: string
	billedModel?: string
	mappedModel?: string
	channelId?: string
	endpoint?: string
	stream?: boolean
	promptTokens?: number
	completionTokens?: number
	quota?: number
	elapsedMs?: number
	httpStatus?: number
	status?: string
	errorCode?: string
	createdAt?: string
}
export default function UsagePage() {
	const [month, setMonth] = useState(utcMonth)
	const [page, setPage] = useState(0)
	const [status, setStatus] = useState("all")
	const [query, setQuery] = useState("")
	const [detail, setDetail] = useState<UsageRow | null>(null)
	const bucket = monthBucket(month)
	const summary = useApi<{ summary: Summary }>(
		bucket ? "/api/admin/usage/summary?bucket=" + bucket : null,
	)
	const recent = useApi<{ usage: UsageRow[] }>(
		bucket
			? `/api/admin/usage?limit=51&skip=${page * 50}&bucket=${bucket}${status === "all" ? "" : "&status=" + encodeURIComponent(status)}`
			: null,
	)
	const data = summary.data?.summary
	const loaded = recent.data?.usage ?? []
	const rows = loaded
		.slice(0, 50)
		.filter((row) =>
			matchesSearch(
				query,
				row.model,
				row.endpoint,
				row.requestId,
				row.channelId,
				row.httpStatus,
			),
		)
	function refresh() {
		summary.reload()
		recent.reload()
	}
	function exportRows() {
		downloadCsv(
			`gateway-usage-${bucket}-page-${page + 1}.csv`,
			[
				"Timestamp",
				"Request ID",
				"Model",
				"Endpoint",
				"Input tokens",
				"Output tokens",
				"Quota",
				"Latency ms",
				"HTTP status",
				"Outcome",
			],
			rows.map((row) => [
				row.createdAt,
				row.requestId,
				row.model,
				row.endpoint,
				row.promptTokens,
				row.completionTokens,
				row.quota,
				row.elapsedMs,
				row.httpStatus,
				row.status,
			]),
		)
	}
	return (
		<>
			<PageHeader
				eyebrow="OBSERVABILITY"
				title="Every request tells a story."
				description="Understand your traffic, inspect failures, and keep model spending in view—without storing prompt content."
				actions={
					<>
						<RefreshButton
							onClick={refresh}
							loading={recent.loading || summary.loading}
						/>
						<button
							className="btn"
							type="button"
							onClick={exportRows}
							disabled={!rows.length || recent.loading}
						>
							<Download size={16} />
							Export page
						</button>
					</>
				}
			/>
			<div className="section-head">
				<span className="section-kicker">
					<Activity size={16} />
					Monthly totals
				</span>
				<label className="month-picker">
					<span className="hint">UTC month</span>
					<input
						type="month"
						aria-label="Usage month in UTC"
						value={month}
						min="2020-01"
						max={utcMonth()}
						required
						onChange={(event) => {
							setMonth(event.target.value)
							setPage(0)
						}}
					/>
				</label>
			</div>
			<ErrorNote
				message={
					!bucket
						? "Choose a valid month to load usage."
						: summary.error || recent.error
				}
			/>
			{summary.loading && !data ? (
				<Loading rows={2} />
			) : data ? (
				<div className="cards section">
					<StatCard
						label="Requests"
						value={formatNumber(data.requests)}
						sub="All requests in the selected month"
						icon={<Activity size={18} />}
					/>
					<StatCard
						label="Spend"
						value={formatUsd(data.usd)}
						sub={`${formatNumber(data.quota)} quota units`}
						icon={<Coins size={18} />}
					/>
					<StatCard
						label="Errors"
						value={formatNumber(data.errors)}
						sub={`${formatPercent(data.errors, data.requests)} of requests`}
						icon={<AlertTriangle size={18} />}
					/>
					<StatCard
						label="Tokens"
						value={formatNumber(data.promptTokens + data.completionTokens)}
						sub={`${formatNumber(data.promptTokens)} input tokens`}
						icon={<Zap size={18} />}
					/>
				</div>
			) : null}
			<Panel title="Request log" note="Most recent first">
				<div className="toolbar">
					<SearchInput
						value={query}
						onChange={setQuery}
						placeholder="Search this page by model or request ID…"
					/>
					<span className="filter-control">
						<select
							aria-label="Filter request outcome"
							value={status}
							onChange={(event) => {
								setStatus(event.target.value)
								setPage(0)
							}}
						>
							<option value="all">All outcomes</option>
							<option value="success">Success</option>
							<option value="error">Error</option>
							<option value="aborted">Aborted</option>
						</select>
					</span>
					<span className="toolbar-count">
						Exports include the filtered page only
					</span>
				</div>
				{recent.loading && !recent.data ? (
					<Loading />
				) : !rows.length ? (
					<Empty>
						<h3>
							{query || status !== "all"
								? "No requests match this view"
								: "A clear view, ready for traffic"}
						</h3>
						<p>
							Requests appear here after usage is flushed. Monthly totals are
							updated by maintenance rollups.
						</p>
						{query || status !== "all" ? (
							<button
								className="btn btn-small"
								type="button"
								onClick={() => {
									setQuery("")
									setStatus("all")
									setPage(0)
								}}
							>
								Clear filters
							</button>
						) : null}
					</Empty>
				) : (
					<div
						className="table-wrap"
						role="region"
						tabIndex={0}
						aria-label="Usage table, scroll for more columns"
					>
						<table>
							<thead>
								<tr>
									<th>Time</th>
									<th>Model</th>
									<th>Tokens</th>
									<th>Quota</th>
									<th>Latency</th>
									<th>Outcome</th>
									<th>
										<span className="sr-only">Inspect</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row, index) => (
									<tr key={row.requestId ?? row._id ?? index}>
										<td className="hint">{formatDate(row.createdAt)}</td>
										<td>
											<span className="mono">{row.model ?? "—"}</span>
											<div className="hint mono">{row.endpoint ?? "—"}</div>
										</td>
										<td className="num">
											{formatNumber(
												(row.promptTokens ?? 0) + (row.completionTokens ?? 0),
											)}
										</td>
										<td className="num">{formatNumber(row.quota ?? 0)}</td>
										<td className="num">
											{row.elapsedMs !== undefined
												? (row.elapsedMs / 1000).toFixed(2) + "s"
												: "—"}
										</td>
										<td>
											<Pill tone={httpTone(row.httpStatus)}>
												{row.httpStatus ?? "—"} · {row.status ?? "unknown"}
											</Pill>
										</td>
										<td>
											<button
												type="button"
												className="icon-btn"
												aria-label={
													"Inspect request " + (row.requestId || index + 1)
												}
												onClick={() => setDetail(row)}
											>
												<Eye size={17} />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<Pagination
					page={page}
					hasMore={loaded.length > 50}
					loading={recent.loading}
					count={rows.length}
					onPage={setPage}
				/>
			</Panel>
			<Dialog
				open={Boolean(detail)}
				title="Request details"
				onClose={() => setDetail(null)}
			>
				{detail ? (
					<div className="dialog-body">
						<div className="endpoint-box">
							<label>Request ID</label>
							<div>
								<code>{detail.requestId ?? "Not available"}</code>
								{detail.requestId ? (
									<CopyButton
										value={detail.requestId}
										label="Copy request ID"
										iconOnly
									/>
								) : null}
							</div>
						</div>
						<dl className="detail-list">
							{[
								["Model", detail.model],
								["Mapped model", detail.mappedModel],
								["Billed model", detail.billedModel],
								["Channel", detail.channelId],
								["Endpoint", detail.endpoint],
								["Outcome", detail.status],
								["HTTP status", detail.httpStatus],
								["Error code", detail.errorCode],
								["Input tokens", detail.promptTokens],
								["Output tokens", detail.completionTokens],
								["Quota units", detail.quota],
								["Streaming", detail.stream ? "Yes" : "No"],
								["Recorded", formatDate(detail.createdAt)],
							].map(([label, value]) => (
								<div key={String(label)}>
									<dt>{label}</dt>
									<dd>{value ?? "—"}</dd>
								</div>
							))}
						</dl>
						<p className="privacy-note">
							Only request metadata is available here, never the prompt or
							completion.
						</p>
					</div>
				) : null}
			</Dialog>
		</>
	)
}
