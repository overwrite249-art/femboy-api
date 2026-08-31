"use client"

import { ErrorNote, Loading, Panel, formatDate, useApi } from "../ui.tsx"

type AuditRow = {
	_id: string
	actorId?: string
	actorRole?: string
	action?: string
	targetType?: string
	targetId?: string
	meta?: Record<string, unknown>
	ipHash?: string
	createdAt?: string
}

export default function AuditPage() {
	const list = useApi<{ audit: AuditRow[] }>("/api/admin/audit?limit=100")
	const rows = list.data?.audit ?? []

	return (
		<>
			<ErrorNote message={list.error} />

			<section className="section">
				<Panel
					title="Audit log"
					note="metadata is scrubbed of anything key-shaped before it is stored"
				>
					{list.loading && rows.length === 0 ? (
						<Loading />
					) : rows.length === 0 ? (
						<div className="empty">Nothing recorded yet.</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>When</th>
									<th>Action</th>
									<th className="hide-sm">Target</th>
									<th className="hide-sm">Actor</th>
									<th className="hide-sm">Source</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr key={row._id}>
										<td className="hint">{formatDate(row.createdAt)}</td>
										<td className="mono">{row.action ?? "\u2014"}</td>
										<td className="hide-sm">
											{row.targetType ?? "\u2014"}
											<div className="hint mono">{row.targetId ?? ""}</div>
										</td>
										<td className="hide-sm">
											{row.actorRole ?? "\u2014"}
											<div className="hint mono">{row.actorId ?? ""}</div>
										</td>
										<td className="hide-sm hint mono">
											{(row.ipHash ?? "").slice(0, 12)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</section>

			<p className="hint">
				Addresses are stored as a keyed hash, never as text, so this page can show
				that two actions came from the same place without revealing where.
			</p>
		</>
	)
}
