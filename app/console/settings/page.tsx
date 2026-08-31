"use client"

import { useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
import { Callout, ErrorNote, Loading, Panel, formatDate, useApi } from "../ui.tsx"

type Setting = { _id: string; value: unknown; updatedAt?: string }

export default function SettingsPage() {
	const list = useApi<{ settings: Setting[] }>("/api/admin/settings")
	const whoami = useApi<Record<string, unknown>>("/api/admin/whoami")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [form, setForm] = useState({ key: "", value: "" })

	function save(event: FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError("")
		let parsed: unknown = form.value
		try {
			parsed = JSON.parse(form.value)
		} catch {
			parsed = form.value
		}
		api
			.post("/api/admin/settings", { key: form.key, value: parsed })
			.then(() => {
				setForm({ key: "", value: "" })
				list.reload()
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : "the request was refused")
			})
			.finally(() => {
				setBusy(false)
			})
	}

	const rows = list.data?.settings ?? []

	return (
		<>
			<ErrorNote message={error || list.error} />

			<section className="section">
				<Panel title="Stored settings" note="database overrides, not environment">
					{list.loading && rows.length === 0 ? (
						<Loading />
					) : rows.length === 0 ? (
						<div className="empty">Nothing stored. Everything comes from the environment.</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>Key</th>
									<th>Value</th>
									<th className="hide-sm">Updated</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr key={row._id}>
										<td className="mono">{row._id}</td>
										<td className="mono">{JSON.stringify(row.value)}</td>
										<td className="hide-sm hint">{formatDate(row.updatedAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</section>

			<section className="section">
				<Panel title="Set a value">
					<form className="form" onSubmit={save}>
						<div className="field">
							<label htmlFor="key">Key</label>
							<input
								id="key"
								value={form.key}
								onChange={(event) =>
									setForm((current) => ({ ...current, key: event.target.value }))
								}
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="value">Value</label>
							<input
								id="value"
								value={form.value}
								onChange={(event) =>
									setForm((current) => ({ ...current, value: event.target.value }))
								}
							/>
							<span className="hint">Parsed as JSON when it can be, otherwise as text.</span>
						</div>
						<div className="form-foot">
							<span className="hint">Written to the audit log.</span>
							<button className="btn btn-primary" type="submit" disabled={busy}>
								Save
							</button>
						</div>
					</form>
				</Panel>
			</section>

			<section className="section">
				<Panel title="This session">
					<pre className="code">{JSON.stringify(whoami.data ?? {}, null, 2)}</pre>
				</Panel>
			</section>

			<Callout tone="warn">
				Secrets belong in environment variables, not here. Anything stored in this
				table is readable by every admin.
			</Callout>
		</>
	)
}
