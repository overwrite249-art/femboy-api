"use client"
import { useRef, useState } from "react"
import type { FormEvent } from "react"
import { Paintbrush, Pencil, Save, ShieldCheck } from "lucide-react"
import {
	ThemePicker,
	useConfirm,
	useToast,
} from "../../components/interface.tsx"
import { api } from "../api.ts"
import { useSession } from "../session-context.tsx"
import {
	Callout,
	Empty,
	ErrorNote,
	Loading,
	PageHeader,
	Panel,
	RefreshButton,
	useApi,
} from "../ui.tsx"
type Setting = { key: string; value: unknown }
export default function SettingsPage() {
	const list = useApi<{ settings: Setting[] }>("/api/admin/settings")
	const user = useSession()
	const confirm = useConfirm()
	const notify = useToast()
	const pending = useRef(false)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [form, setForm] = useState({ key: "", value: "" })
	async function save(event: FormEvent) {
		event.preventDefault()
		if (pending.current) return
		if (
			!(await confirm({
				title: "Save this setting?",
				description:
					"Stored settings are readable by every administrator. Do not save passwords, API keys, connection strings, or other secrets here.",
				action: "Save setting",
			}))
		)
			return
		pending.current = true
		setBusy(true)
		setError("")
		let parsed: unknown = form.value
		try {
			parsed = JSON.parse(form.value)
		} catch {
			/* Plain text values are allowed. */
		}
		try {
			await api.post("/api/admin/settings", { key: form.key, value: parsed })
			setForm({ key: "", value: "" })
			list.reload()
			notify("Setting saved.")
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The setting could not be saved.",
			)
		} finally {
			pending.current = false
			setBusy(false)
		}
	}
	const rows = list.data?.settings ?? []
	return (
		<>
			<PageHeader
				eyebrow="WORKSPACE PREFERENCES"
				title="Make this space yours."
				description="Personalize the console and review non-secret gateway configuration."
				actions={<RefreshButton onClick={list.reload} loading={list.loading} />}
			/>
			<ErrorNote message={error || list.error} />
			<div className="split section">
				<Panel title="Appearance" note="This browser only">
					<div className="appearance-row">
						<span className="empty-icon">
							<Paintbrush size={24} />
						</span>
						<div>
							<h3>Your preferred theme</h3>
							<p className="hint">Choose light, dark, or follow your system.</p>
						</div>
					</div>
					<ThemePicker />
					<p className="hint" style={{ marginTop: 16 }}>
						Only theme and sidebar preferences are stored locally. API keys and
						session tokens are not stored in localStorage.
					</p>
				</Panel>
				<Panel title="Signed-in account" note="Current session">
					<dl className="detail-list">
						{[
							["Username", user?.username],
							["Role", user?.role],
							["Routing group", user?.group],
							["Authentication", "Console session"],
						].map(([label, value]) => (
							<div key={label}>
								<dt>{label}</dt>
								<dd>{value ?? "—"}</dd>
							</div>
						))}
					</dl>
					<p className="privacy-note">
						<ShieldCheck size={16} />
						Console sessions and API keys are separate. Sign out from the
						account control in the sidebar.
					</p>
				</Panel>
			</div>
			<section className="section">
				<Panel title="Stored configuration" note="Not environment variables">
					{list.loading && !list.data ? (
						<Loading />
					) : !rows.length ? (
						<Empty>
							<h3>Clean defaults. Less to maintain.</h3>
							<p>
								No settings have been stored in this table. Environment
								variables and built-in defaults remain separate.
							</p>
						</Empty>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Setting</th>
										<th>Value</th>
										<th>
											<span className="sr-only">Edit</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((row) => (
										<tr key={row.key}>
											<td className="mono">{row.key}</td>
											<td>
												<code className="setting-value">
													{JSON.stringify(row.value)}
												</code>
											</td>
											<td>
												<button
													className="btn btn-small"
													type="button"
													onClick={() => {
														setForm({
															key: row.key,
															value: JSON.stringify(row.value) ?? "",
														})
														setTimeout(
															() =>
																document.getElementById("setting-key")?.focus(),
															0,
														)
													}}
												>
													<Pencil size={14} />
													Edit
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Panel>
			</section>
			<section className="section">
				<Panel title="Set a non-secret value" note="Advanced">
					<form className="form" onSubmit={save}>
						<div className="field">
							<label htmlFor="setting-key">Setting key</label>
							<input
								id="setting-key"
								value={form.key}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										key: event.target.value,
									}))
								}
								maxLength={120}
								required
								placeholder="Setting name"
							/>
						</div>
						<div className="field">
							<label htmlFor="setting-value">Value</label>
							<input
								id="setting-value"
								value={form.value}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										value: event.target.value,
									}))
								}
								maxLength={20000}
								placeholder="JSON or plain text"
							/>
							<span className="hint">
								JSON is parsed when valid; otherwise saved as text. Only
								settings read by the gateway affect behavior.
							</span>
						</div>
						<div className="form-foot">
							<span className="hint">
								Saving an existing key replaces its value.
							</span>
							<button
								className="btn"
								type="button"
								disabled={busy}
								onClick={() => setForm({ key: "", value: "" })}
							>
								Clear
							</button>
							<button className="btn btn-primary" type="submit" disabled={busy}>
								<Save size={16} />
								{busy ? "Saving…" : "Save setting"}
							</button>
						</div>
					</form>
				</Panel>
			</section>
			<Callout tone="warn">
				Server secrets belong in your hosting provider’s environment settings,
				never in this table. Changes here do not update Vercel environment
				variables or rotate server secrets.
			</Callout>
		</>
	)
}
