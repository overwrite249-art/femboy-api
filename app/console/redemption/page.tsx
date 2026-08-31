"use client"

import { useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
import {
	Callout,
	ErrorNote,
	Loading,
	Panel,
	Pill,
	formatDate,
	formatNumber,
	statusTone,
	useApi,
} from "../ui.tsx"

type Code = {
	_id: string
	codePrefix?: string
	quota: number
	status: string
	batchId?: string
	usedBy?: string
	usedAt?: string
	createdAt?: string
}

export default function RedemptionPage() {
	const list = useApi<{ codes: Code[] }>("/api/admin/redemption")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [codes, setCodes] = useState<string[]>([])
	const [form, setForm] = useState({ count: "5", quota: "500000" })

	async function run(action: () => Promise<unknown>) {
		setBusy(true)
		setError("")
		try {
			await action()
			list.reload()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "the request was refused")
		} finally {
			setBusy(false)
		}
	}

	function create(event: FormEvent) {
		event.preventDefault()
		void run(async () => {
			const batch = await api.post<{ codes?: string[] }>("/api/admin/redemption", {
				count: Number(form.count),
				quota: Number(form.quota),
			})
			setCodes(batch.codes ?? [])
		})
	}

	const rows = list.data?.codes ?? []

	return (
		<>
			<ErrorNote message={error || list.error} />

			{codes.length > 0 ? (
				<section className="section">
					<Callout tone="ok">
						These codes are shown once. Only their digests are stored, so this list
						cannot be produced again.
					</Callout>
					<pre className="code">{codes.join("\n")}</pre>
					<div className="form-foot">
						<span className="hint">{codes.length} codes</span>
						<button className="btn btn-small" type="button" onClick={() => setCodes([])}>
							I have saved them
						</button>
					</div>
				</section>
			) : null}

			<section className="section">
				<Panel title="Redemption codes" note="single use, digest only">
					{list.loading && rows.length === 0 ? (
						<Loading />
					) : rows.length === 0 ? (
						<div className="empty">No codes yet.</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>Prefix</th>
									<th className="num">Value</th>
									<th className="hide-sm">Batch</th>
									<th className="hide-sm">Created</th>
									<th>State</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr key={row._id}>
										<td className="mono">{(row.codePrefix ?? "") + "..."}</td>
										<td className="num">{formatNumber(row.quota)}</td>
										<td className="mono hide-sm hint">{row.batchId ?? "\u2014"}</td>
										<td className="hide-sm hint">{formatDate(row.createdAt)}</td>
										<td>
											<Pill tone={statusTone(row.status)} dot>
												{row.status}
											</Pill>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</section>

			<section className="section">
				<Panel title="Generate a batch">
					<form className="form" onSubmit={create}>
						<div className="field">
							<label htmlFor="count">How many</label>
							<input
								id="count"
								value={form.count}
								onChange={(event) =>
									setForm((current) => ({ ...current, count: event.target.value }))
								}
								inputMode="numeric"
							/>
							<span className="hint">Up to 500 per batch.</span>
						</div>
						<div className="field">
							<label htmlFor="quota">Value each</label>
							<input
								id="quota"
								value={form.quota}
								onChange={(event) =>
									setForm((current) => ({ ...current, quota: event.target.value }))
								}
								inputMode="numeric"
							/>
							<span className="hint">500,000 quota units is one US dollar.</span>
						</div>
						<div className="form-foot">
							<span className="hint">Written to the audit log.</span>
							<button className="btn btn-primary" type="submit" disabled={busy}>
								Generate
							</button>
						</div>
					</form>
				</Panel>
			</section>
		</>
	)
}
