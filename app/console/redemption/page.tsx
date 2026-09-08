"use client"

import { useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
import { CopyButton, useConfirm } from "../../components/interface.tsx"
import { PageHeader, RefreshButton } from "../ui.tsx"
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
	const confirm = useConfirm()
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
			setError(
				cause instanceof Error ? cause.message : "the request was refused",
			)
		} finally {
			setBusy(false)
		}
	}

	async function create(event: FormEvent) {
		event.preventDefault()
		if (busy || codes.length) return
		if (
			!(await confirm({
				title: "Generate credit codes?",
				description: `This creates ${form.count} single-use codes worth ${form.quota} quota units each. Anyone holding a valid code can redeem its credit; distribute them privately.`,
				action: "Generate codes",
			}))
		)
			return
		void run(async () => {
			const batch = await api.post<{ codes?: string[] }>(
				"/api/admin/redemption",
				{
					count: Number(form.count),
					quota: Number(form.quota),
				},
			)
			setCodes(batch.codes ?? [])
		})
	}

	const rows = list.data?.codes ?? []

	return (
		<>
			<PageHeader
				eyebrow="CREDIT DISTRIBUTION"
				title="Give your next idea a little credit."
				description="Create single-use redemption codes to allocate quota without sharing account credentials."
				actions={<RefreshButton onClick={list.reload} loading={list.loading} />}
			/>
			<ErrorNote message={error || list.error} />

			{codes.length > 0 ? (
				<section className="section">
					<Callout tone="ok">
						These codes are shown once. Only their digests are stored, so this
						list cannot be produced again.
					</Callout>
					<pre className="code">{codes.join("\n")}</pre>
					<div className="form-foot">
						<span className="hint">
							{codes.length} codes · keep this list private
						</span>
						<CopyButton value={codes.join("\n")} label="Copy codes" />
						<button
							className="btn btn-small"
							type="button"
							onClick={() => setCodes([])}
						>
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
										<td className="mono hide-sm hint">
											{row.batchId ?? "\u2014"}
										</td>
										<td className="hide-sm hint">
											{formatDate(row.createdAt)}
										</td>
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
								type="number"
								min={1}
								max={500}
								step={1}
								required
								value={form.count}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										count: event.target.value,
									}))
								}
								inputMode="numeric"
							/>
							<span className="hint">Up to 500 per batch.</span>
						</div>
						<div className="field">
							<label htmlFor="quota">Value each</label>
							<input
								id="quota"
								type="number"
								min={1}
								step={1}
								required
								value={form.quota}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										quota: event.target.value,
									}))
								}
								inputMode="numeric"
							/>
							<span className="hint">
								Quota units, not dollars. Check the overview for this
								deployment’s conversion rate.
							</span>
						</div>
						<div className="form-foot">
							<span className="hint">Written to the audit log.</span>
							<button
								className="btn btn-primary"
								type="submit"
								disabled={busy || codes.length > 0}
							>
								Generate
							</button>
						</div>
					</form>
				</Panel>
			</section>
		</>
	)
}
