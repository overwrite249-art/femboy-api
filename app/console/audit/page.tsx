"use client"
import { useState } from "react"
import { Download, Eye, ShieldCheck } from "lucide-react"
import { CopyButton, Dialog } from "../../components/interface.tsx"
import {
	downloadCsv,
	matchesSearch,
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
	formatDate,
	useApi,
} from "../ui.tsx"
type AuditRow = {
	_id: string
	actorId?: string
	actorRole?: string
	action?: string
	targetType?: string
	targetId?: string
	ipHash?: string
	createdAt?: string
}
export default function AuditPage() {
	const [page, setPage] = useState(0)
	const [query, setQuery] = useState("")
	const [action, setAction] = useState("all")
	const [detail, setDetail] = useState<AuditRow | null>(null)
	const list = useApi<{ audit: AuditRow[] }>(
		`/api/admin/audit?limit=51&skip=${page * 50}`,
	)
	const loaded = list.data?.audit ?? []
	const pageRows = loaded.slice(0, 50)
	const rows = pageRows.filter(
		(row) =>
			matchesSearch(
				query,
				row.action,
				row.actorRole,
				row.actorId,
				row.targetType,
				row.targetId,
			) &&
			(action === "all" || row.action === action),
	)
	function exportRows() {
		downloadCsv(
			`gateway-audit-page-${page + 1}.csv`,
			[
				"Timestamp",
				"Action",
				"Target type",
				"Target ID",
				"Actor role",
				"Actor ID",
			],
			rows.map((row) => [
				row.createdAt,
				row.action,
				row.targetType,
				row.targetId,
				row.actorRole,
				row.actorId,
			]),
		)
	}
	return (
		<>
			<PageHeader
				eyebrow="System"
				title="Audit trail"
				description="Review administrative changes, trace who did what, and export the records you need."
				actions={
					<>
						<RefreshButton onClick={list.reload} loading={list.loading} />
						<button
							className="btn"
							type="button"
							onClick={exportRows}
							disabled={!rows.length || list.loading}
						>
							<Download size={16} />
							Export page
						</button>
					</>
				}
			/>
			<ErrorNote message={list.error} />
			<Panel title="Administrative events" note="Newest first">
				<div className="toolbar">
					<SearchInput
						value={query}
						onChange={setQuery}
						placeholder="Search this page by action, actor, or target…"
					/>
					<span className="filter-control">
						<select
							aria-label="Filter audit action on this page"
							value={action}
							onChange={(event) => setAction(event.target.value)}
						>
							<option value="all">All actions on this page</option>
							{Array.from(
								new Set(pageRows.map((row) => row.action).filter(Boolean)),
							)
								.sort()
								.map((value) => (
									<option key={value}>{value}</option>
								))}
						</select>
					</span>
				</div>
				{list.loading && !list.data ? (
					<Loading />
				) : rows.length ? (
					<div
						className="table-wrap"
						role="region"
						tabIndex={0}
						aria-label="Audit table, scroll for more columns"
					>
						<table>
							<thead>
								<tr>
									<th>Time</th>
									<th>Action</th>
									<th>Target</th>
									<th>Actor</th>
									<th>
										<span className="sr-only">Inspect</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr key={row._id}>
										<td className="hint">{formatDate(row.createdAt)}</td>
										<td>
											<Pill tone="info">{row.action ?? "—"}</Pill>
										</td>
										<td>
											{row.targetType ?? "—"}
											<div className="hint mono">{row.targetId ?? ""}</div>
										</td>
										<td>
											{row.actorRole ?? "—"}
											<div className="hint mono">{row.actorId ?? ""}</div>
										</td>
										<td>
											<button
												className="icon-btn"
												type="button"
												aria-label={"Inspect event " + row._id}
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
				) : (
					<Empty>
						<h3>
							{query || action !== "all"
								? "No matching events"
								: "No events recorded yet"}
						</h3>
						<p>
							Changes to keys, channels, users, and configuration will appear
							here.
						</p>
						{query || action !== "all" ? (
							<button
								className="btn btn-small"
								type="button"
								onClick={() => {
									setQuery("")
									setAction("all")
								}}
							>
								Clear filters
							</button>
						) : null}
					</Empty>
				)}
				<Pagination
					page={page}
					hasMore={loaded.length > 50}
					loading={list.loading}
					count={rows.length}
					onPage={(value) => {
						setPage(value)
						setAction("all")
					}}
				/>
			</Panel>
			<p className="privacy-note">
				<ShieldCheck size={16} />
				Client addresses are hashed, not stored as raw IPs. Exports include only
				the filtered page’s allowlisted metadata, not credentials or raw event
				payloads.
			</p>
			<Dialog
				open={Boolean(detail)}
				title="Audit event"
				onClose={() => setDetail(null)}
			>
				{detail ? (
					<div className="dialog-body">
						<div className="endpoint-box">
							<label>Event ID</label>
							<div>
								<code>{detail._id}</code>
								<CopyButton value={detail._id} label="Copy event ID" iconOnly />
							</div>
						</div>
						<dl className="detail-list">
							{[
								["Action", detail.action],
								["Target type", detail.targetType],
								["Target ID", detail.targetId],
								["Actor role", detail.actorRole],
								["Actor ID", detail.actorId],
								["Recorded", formatDate(detail.createdAt)],
								["Source hash prefix", detail.ipHash?.slice(0, 12)],
							].map(([label, value]) => (
								<div key={label}>
									<dt>{label}</dt>
									<dd>{value || "—"}</dd>
								</div>
							))}
						</dl>
					</div>
				) : null}
			</Dialog>
		</>
	)
}
